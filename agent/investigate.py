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


def investigate_rules(run_id: str, alarm_channel: str = "EPS.bus_voltage") -> str:
    spec = load_and_validate()
    conn = connect()
    init_schema(conn)
    tools = Tools(conn, spec)

    procedure = tools.get_doc("EPS-17")
    if procedure is None:
        raise SystemExit("EPS-17 is not in the store — run: python -m storage ingest")

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

    heater_at_cmd = (
        tools.sample(run_id, "THM.heater_b_current", heater_enable["time_s"])
        if heater_enable
        else None
    )

    heater_nominal = spec["channels"]["THM.heater_b_current"]["nominal_range"]
    heater_healthy_max = heater_nominal[1]
    heater_value = _num(heater_at_cmd) or _num(heater_now)
    heater_ratio = (heater_value / heater_healthy_max) if heater_value else None

    similar_hits = tools.search_docs("overcurrent")
    similar_id = next((row["id"] for row in similar_hits if row["kind"] == "incident"), None)
    similar = tools.get_doc(similar_id) if similar_id else None
    prior_heater = tools.sample("inc0187", "THM.heater_b_current", 1 * 3600 + 52 * 60) if similar else None

    lines = [
        f"# Investigation {run_id}",
        "",
        f"- **Entry:** `{alarm_channel}` warn (limit {warn_limit} {warn_meta['unit']})",
        "- **Procedure:** EPS-17",
        "- **Scope:** assemble evidence and recommend a human decision. Does not command the spacecraft.",
        "",
        "## Timeline",
        "",
        f"1. `{alarm_channel}` first crossed warn at **{format_clock(t_warn)}** "
        f"({_fmt(crossing)} {warn_meta['unit']}). **[OBSERVED]**",
    ]

    if events:
        lines.append(
            "2. Commands / mode changes in the 10 minutes before that (EPS-17 step 2). **[OBSERVED]**"
        )
        for event in events:
            lines.append(
                f"   - {format_clock(event['time_s'])} `{event['detail']}` on `{event['channel']}`"
            )
    else:
        lines.append("2. No commands in the 10 minutes before the warn. **[OBSERVED]**")

    if heater_enable and heater_value is not None:
        lines.append(
            f"3. At `HEATER_B_ENABLE` ({format_clock(heater_enable['time_s'])}), "
            f"`THM.heater_b_current` = **{heater_value:.2f} A**. "
            f"Healthy ON range is {heater_nominal[0]}–{heater_healthy_max} A. **[OBSERVED / DOCUMENTED]**"
        )
        if heater_ratio is not None:
            lines.append(
                f"4. That is **{heater_ratio:.1f}×** the healthy-max draw. "
                f"EPS-17 treats ≥2× as the prime suspect. **[DERIVED]**"
            )
    else:
        lines.append("3. No `HEATER_B_ENABLE` in the window. **[OBSERVED]**")

    if science:
        pval = _num(payload_now)
        mode = payload_mode["value_text"] if payload_mode else "?"
        lines.append(
            f"5. `{science['detail']}` at {format_clock(science['time_s'])}: "
            f"`PAY.mode` = {mode}, `PAY.payload_current` = "
            f"{pval:.2f} A. **[OBSERVED]**"
        )
        lines.append(
            "6. EPS-17: a SCIENCE_MODE entry raises bus current, but payload current "
            "on Aurora-1 is < 1 A and cannot explain a several-amp heater step. "
            "Do not close on the payload without checking the heater. **[DOCUMENTED]**"
        )

    if bus_i and _num(bus_i) is not None:
        bus_warn = spec["channels"]["EPS.bus_current"]["warn_limit"]
        extra = " (at/over bus-current warn)" if _num(bus_i) >= bus_warn else " (bus-current warn not required to blame the heater)"
        lines.append(
            f"7. At the voltage warn, `EPS.bus_current` = **{_num(bus_i):.2f} A**{extra}. **[OBSERVED]**"
        )

    if heater_temp and _num(heater_temp) is not None:
        lines.append(
            f"8. `THM.heater_b_temperature` = **{_num(heater_temp):.1f} °C** at the warn "
            f"(nominal 10–20 °C, warn 40 °C). **[OBSERVED]**"
        )

    if similar and prior_heater and _num(prior_heater) is not None:
        lines.append(
            f"9. Similar-incident search for “overcurrent” returned **{similar_id}**. "
            f"Prior heater current after enable was **{_num(prior_heater):.2f} A** — same signature, "
            f"payload stayed STANDBY. **[DOCUMENTED / OBSERVED]**"
        )

    lines += ["", "## Hypothesis", ""]
    if heater_ratio is not None and heater_ratio >= 2:
        lines.append(
            "**HEATER_B_OVERCURRENT** (FAULT-001): Heater B draws ~3× when commanded ON. "
            "The SCIENCE_MODE step is a confounder, not the root cause. **[HYPOTHESIS]**"
        )
    else:
        lines.append("Heater current is not ≥2× healthy. Root cause still open. **[HYPOTHESIS]**")

    lines += [
        "",
        "## Recommended human decision",
        "",
        "Inhibit Heater B and watch `EPS.bus_voltage` recover (EPS-17 step 6). "
        "Do **not** safe the payload first. **[HYPOTHESIS — not executed]**",
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
