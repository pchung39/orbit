"""Investigation entry: LLM tool loop by default, rules path as fallback.

python -m agent investigate eps204
python -m agent investigate eps204 --provider openai
python -m agent investigate eps204 --provider rules
"""

from __future__ import annotations

import argparse
from pathlib import Path

from agent.llm import investigate_llm, resolve_provider
from agent.tools import Tools, _fmt
from simulator.scenarios import format_clock
from simulator.simulate import load_and_validate
from storage.store import connect, init_schema

ROOT = Path(__file__).resolve().parent.parent


def _num(row: dict | None) -> float | None:
    if row is None:
        return None
    return row.get("value_num")


def _similar_incident(tools: Tools, query: str, prefer_id: str | None) -> tuple[str | None, dict | None]:
    hits = tools.search_docs(query)
    authored: list[tuple[str, dict]] = []
    for row in hits:
        if row.get("kind") != "incident":
            continue
        doc = tools.get_doc(row["id"])
        if not doc:
            continue
        if str(doc.get("path") or "").startswith("filed:"):
            continue
        authored.append((row["id"], doc))
    for doc_id, doc in authored:
        if prefer_id and doc_id == prefer_id:
            return doc_id, doc
    if prefer_id:
        doc = tools.get_doc(prefer_id)
        if doc and not str(doc.get("path") or "").startswith("filed:"):
            return prefer_id, doc
    if authored:
        return authored[0]
    return None, None


def investigate_rules(run_id: str, alarm_channel: str = "EPS.bus_voltage") -> str:
    spec = load_and_validate()
    conn = connect()
    init_schema(conn)
    tools = Tools(conn, spec)

    warn_meta = spec["channels"][alarm_channel]
    warn_limit = warn_meta["warn_limit"]
    crossing = tools.first_warn(run_id, alarm_channel)
    if crossing is None:
        return f"# Investigation {run_id}\n\nNo {alarm_channel} warn crossing found. **[OBSERVED]**\n"

    t_warn = crossing["time_s"]
    events = tools.events_before(run_id, t_warn, window_s=600.0)

    heater_enable = next((e for e in events if e["detail"] == "HEATER_B_ENABLE"), None)
    science = next((e for e in events if e["detail"] == "SCIENCE_MODE"), None)

    heater_now = tools.sample(run_id, "THM.heater_b_current", t_warn)
    payload_now = tools.sample(run_id, "PAY.payload_current", t_warn)
    payload_mode = tools.sample(run_id, "PAY.mode", t_warn)
    bus_i = tools.sample(run_id, "EPS.bus_current", t_warn)
    heater_temp = tools.sample(run_id, "THM.heater_b_temperature", t_warn)
    batt_v = tools.sample(run_id, "EPS.battery_voltage", t_warn)

    heater_at_cmd = (
        tools.sample(run_id, "THM.heater_b_current", heater_enable["time_s"])
        if heater_enable
        else None
    )

    heater_nominal = spec["channels"]["THM.heater_b_current"]["nominal_range"]
    heater_healthy_max = heater_nominal[1]
    heater_value = _num(heater_at_cmd) or _num(heater_now)
    heater_ratio = (heater_value / heater_healthy_max) if heater_value else None

    payload_healthy_science = spec["channels"]["PAY.payload_current"]["nominal_range"][1]
    payload_value = _num(payload_now)
    payload_ratio = (payload_value / payload_healthy_science) if payload_value else None

    heater_guilty = heater_ratio is not None and heater_ratio >= 2
    payload_guilty = (not heater_guilty) and payload_ratio is not None and payload_ratio >= 2
    battery_family = (not heater_guilty) and (not payload_guilty) and (
        alarm_channel == "EPS.battery_voltage"
        or (batt_v is not None and _num(batt_v) is not None and _num(batt_v) < spec["channels"]["EPS.battery_voltage"]["warn_limit"])
    )

    if heater_guilty:
        procedure_id = "EPS-17"
        family = "heater"
        similar_query, prefer = "heater overcurrent", "INC-0187"
    elif payload_guilty:
        procedure_id = "PAY-04"
        family = "payload"
        similar_query, prefer = "payload power spike SCIENCE_MODE", "INC-0191"
    elif battery_family:
        procedure_id = "EPS-09"
        family = "battery"
        similar_query, prefer = "battery internal resistance eclipse", "INC-0162"
    else:
        procedure_id = "EPS-17"
        family = "open"
        similar_query, prefer = "overcurrent", "INC-0187"

    procedure = tools.get_doc(procedure_id)
    if procedure is None:
        raise SystemExit(f"{procedure_id} is not in the store — run: python -m storage ingest")

    similar_id, similar = _similar_incident(tools, similar_query, prefer)
    prior_heater = tools.sample("inc0187", "THM.heater_b_current", 1 * 3600 + 52 * 60) if similar_id == "INC-0187" else None
    prior_payload = tools.sample("inc0191", "PAY.payload_current", 8 * 3600 + 14 * 60) if similar_id == "INC-0191" else None
    prior_batt = tools.sample("inc0162", "EPS.battery_voltage", 18 * 60) if similar_id == "INC-0162" else None

    lines = [
        f"# Investigation {run_id}",
        "",
        f"- **Entry:** `{alarm_channel}` warn (limit {warn_limit} {warn_meta['unit']})",
        f"- **Procedure:** {procedure_id}",
        "- **Scope:** assemble evidence and recommend a human decision. Does not command the spacecraft.",
        "",
        "## Timeline",
        "",
        f"1. `{alarm_channel}` first crossed warn at **{format_clock(t_warn)}** "
        f"({_fmt(crossing)} {warn_meta['unit']}). **[OBSERVED]**",
    ]

    if events:
        lines.append(
            "2. Commands / mode changes in the 10 minutes before that. **[OBSERVED]**"
        )
        for event in events:
            lines.append(
                f"   - {format_clock(event['time_s'])} `{event['detail']}` on `{event['channel']}`"
            )
    else:
        lines.append("2. No commands in the 10 minutes before the warn. **[OBSERVED]**")

    n = 3
    if heater_enable and heater_value is not None:
        lines.append(
            f"{n}. At `HEATER_B_ENABLE` ({format_clock(heater_enable['time_s'])}), "
            f"`THM.heater_b_current` = **{heater_value:.2f} A**. "
            f"Healthy ON range is {heater_nominal[0]}–{heater_healthy_max} A. **[OBSERVED / DOCUMENTED]**"
        )
        n += 1
        if heater_ratio is not None:
            lines.append(
                f"{n}. That is **{heater_ratio:.1f}×** the healthy-max draw. "
                f"EPS-17 treats ≥2× as the prime suspect. **[DERIVED]**"
            )
            n += 1
    elif heater_value is not None:
        lines.append(
            f"{n}. `THM.heater_b_current` = **{heater_value:.2f} A** at the warn "
            f"(healthy ON {heater_nominal[0]}–{heater_healthy_max} A). **[OBSERVED]**"
        )
        n += 1
    else:
        lines.append(f"{n}. No heater current sample at the warn. **[OBSERVED]**")
        n += 1

    if science:
        pval = payload_value
        mode = payload_mode["value_text"] if payload_mode else "?"
        lines.append(
            f"{n}. `{science['detail']}` at {format_clock(science['time_s'])}: "
            f"`PAY.mode` = {mode}, `PAY.payload_current` = "
            f"{pval:.2f} A. **[OBSERVED]**"
        )
        n += 1
        if payload_guilty:
            lines.append(
                f"{n}. That is **{payload_ratio:.1f}×** the 0.9 A healthy science draw. "
                f"PAY-04 treats ≥2× as the prime suspect. Heater current is not ≥2× — "
                f"do not inhibit Heater B. **[DERIVED / DOCUMENTED]**"
            )
            n += 1
        else:
            lines.append(
                f"{n}. EPS-17: a SCIENCE_MODE entry raises bus current, but payload current "
                "on Aurora-1 is < 1 A and cannot explain a several-amp heater step. "
                "Do not close on the payload without checking the heater. **[DOCUMENTED]**"
            )
            n += 1
    elif payload_value is not None:
        mode = payload_mode["value_text"] if payload_mode else "?"
        lines.append(
            f"{n}. `PAY.mode` = {mode}, `PAY.payload_current` = **{payload_value:.2f} A**. **[OBSERVED]**"
        )
        n += 1

    if bus_i and _num(bus_i) is not None:
        bus_warn = spec["channels"]["EPS.bus_current"]["warn_limit"]
        extra = " (at/over bus-current warn)" if _num(bus_i) >= bus_warn else ""
        lines.append(
            f"{n}. At the warn, `EPS.bus_current` = **{_num(bus_i):.2f} A**{extra}. **[OBSERVED]**"
        )
        n += 1

    if batt_v and _num(batt_v) is not None:
        lines.append(
            f"{n}. `EPS.battery_voltage` = **{_num(batt_v):.2f} V** "
            f"(warn 25.5 V). **[OBSERVED]**"
        )
        n += 1

    if heater_temp and _num(heater_temp) is not None:
        lines.append(
            f"{n}. `THM.heater_b_temperature` = **{_num(heater_temp):.1f} °C** at the warn "
            f"(nominal 10–20 °C, warn 40 °C). **[OBSERVED]**"
        )
        n += 1

    if similar_id == "INC-0187" and similar and prior_heater and _num(prior_heater) is not None:
        lines.append(
            f"{n}. Prior incident **{similar_id}**. "
            f"Prior heater current after enable was **{_num(prior_heater):.2f} A** — same signature, "
            f"payload stayed STANDBY. **[DOCUMENTED / OBSERVED]**"
        )
    elif similar_id == "INC-0191" and similar and prior_payload and _num(prior_payload) is not None:
        lines.append(
            f"{n}. Prior incident **{similar_id}**. "
            f"Prior payload current after SCIENCE_MODE was **{_num(prior_payload):.2f} A** — "
            f"heater stayed off. **[DOCUMENTED / OBSERVED]**"
        )
    elif similar_id == "INC-0162" and similar and prior_batt and _num(prior_batt) is not None:
        lines.append(
            f"{n}. Prior incident **{similar_id}**. "
            f"Prior battery voltage after a healthy heater enable was **{_num(prior_batt):.2f} V**. **[DOCUMENTED / OBSERVED]**"
        )
    elif similar_id and similar:
        lines.append(
            f"{n}. Prior incident **{similar_id}**. **[DOCUMENTED]**"
        )

    lines += ["", "## Hypothesis", ""]
    if family == "heater":
        if science:
            lines.append(
                "**HEATER_B_OVERCURRENT** (FAULT-001): Heater B draws ~3× when commanded ON. "
                "The SCIENCE_MODE step is a confounder, not the root cause. **[HYPOTHESIS]**"
            )
        else:
            lines.append(
                "**HEATER_B_OVERCURRENT** (FAULT-001): Heater B draws ~3× when commanded ON. "
                "Payload stayed STANDBY. **[HYPOTHESIS]**"
            )
    elif family == "payload":
        lines.append(
            "**PAYLOAD_POWER_SPIKE** (FAULT-002): payload current is ~3× the healthy science "
            "baseline. Heater B is not the load. **[HYPOTHESIS]**"
        )
    elif family == "battery":
        lines.append(
            "**BATTERY_RESISTANCE_DEGRADATION** (FAULT-003): pack voltage sagged under a healthy "
            "load. Do not inhibit Heater B. **[HYPOTHESIS]**"
        )
    else:
        lines.append("Load currents are not ≥2× healthy. Root cause still open. **[HYPOTHESIS]**")

    lines += ["", "## Recommended human decision", ""]
    if family == "heater":
        lines.append(
            "Inhibit Heater B and watch `EPS.bus_voltage` recover (EPS-17 step 6). "
            "Do **not** safe the payload first. **[HYPOTHESIS — not executed]**"
        )
    elif family == "payload":
        lines.append(
            "Safe the payload to STANDBY and watch `PAY.payload_current` fall (PAY-04 step 6). "
            "Do **not** inhibit Heater B. **[HYPOTHESIS — not executed]**"
        )
    elif family == "battery":
        lines.append(
            "Continue EPS-09 battery checkout. Do **not** inhibit Heater B and do **not** "
            "safe the payload — both currents are healthy. **[HYPOTHESIS — not executed]**"
        )
    else:
        lines.append("Keep reading. No ≥2× load to inhibit. **[HYPOTHESIS — not executed]**")

    lines += [
        "",
        "ORBIT stops here. An operator has to send the command.",
        "",
        "## Tool log",
        "",
    ]
    lines.extend(f"- {item}" for item in tools.log)
    return "\n".join(lines) + "\n"


def investigate(run_id: str, alarm_channel: str, provider: str, model: str | None) -> str:
    if provider == "rules":
        return investigate_rules(run_id, alarm_channel)
    spec = load_and_validate()
    conn = connect()
    init_schema(conn)
    tools = Tools(conn, spec)
    return investigate_llm(tools, run_id, alarm_channel, provider, model=model)


def main() -> None:
    parser = argparse.ArgumentParser(description="ORBIT investigation agent")
    sub = parser.add_subparsers(dest="cmd", required=True)
    inv = sub.add_parser("investigate", help="run a tagged investigation from store data")
    inv.add_argument("run_id", nargs="?", default="eps204")
    inv.add_argument("--alarm", default="EPS.bus_voltage")
    inv.add_argument(
        "--provider",
        choices=("auto", "anthropic", "openai", "rules"),
        default="auto",
        help="auto prefers Claude when both keys exist",
    )
    inv.add_argument("--model", default=None, help="override model id")
    inv.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    if args.provider == "rules":
        provider = "rules"
    else:
        provider = resolve_provider(args.provider)
    report = investigate(args.run_id, args.alarm, provider, args.model)
    out = args.out or ROOT / "investigations" / f"{args.run_id}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report)
    print(report)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
