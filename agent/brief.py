"""Structured case brief for the case page.

The markdown report stays the eval artifact. The brief is the same investigation
as data: facts, per-load numbers, which signal moved first, competing
explanations with for/against evidence, the chart recipe, and the tool trail.
Every number in every sentence is computed here from the sealed tape and the
mission spec, so captions cannot drift from the data they describe.
"""

from __future__ import annotations

import statistics
from functools import lru_cache
from typing import Any

from agent.hypothesis import (
    HYPOTHESIS_BY_FAMILY,
    MARGINAL_MIN,
    PROCEDURE_BY_FAMILY,
    Measurements,
    classify,
    measure,
)
from agent.tools import Tools
from simulator.scenarios import format_clock
from simulator.simulate import load_and_validate
from simulator import replay as sim
from storage.evidence import query_channel, read_sealed_meta

HEATER = "THM.heater_b_current"
PAYLOAD = "PAY.payload_current"
BUS_I = "EPS.bus_current"
BUS_V = "EPS.bus_voltage"
BATT_V = "EPS.battery_voltage"

# Load is "on" only if its mean draw rose by more than this after a command.
STEP_MIN_A = 0.3
BEFORE_S = 240.0  # window before the first command, for the healthy baseline
AFTER_FROM_S, AFTER_TO_S = 60.0, 180.0  # window after the warn, for settled draw

STEP_BY_FAMILY = {
    "heater": ("EPS-17", "4", "Step 4 met: load ≥2× healthy"),
    "payload": ("PAY-04", "4", "Step 4 met: payload ≥2× science"),
    "battery": ("EPS-09", "5", "Step 5: loads healthy, pack suspect"),
    "withheld": ("EPS-17", "4", "Step 4 not met: hold"),
    "open": ("EPS-17", "4", "No load clears step 4"),
}

LEADING_LABEL = {
    "heater": "Heater B",
    "payload": "Payload",
    "battery": "Battery pack",
    "withheld": "None yet",
    "open": "None",
}


def _mean(run_id: str, channel: str, t0: float, t1: float) -> float | None:
    vals = [r["value_num"] for r in query_channel(run_id, channel, t0, t1) if r["value_num"] is not None]
    return statistics.fmean(vals) if vals else None


def _dur(seconds: float) -> str:
    seconds = int(round(abs(seconds)))
    m, s = divmod(seconds, 60)
    if m and s:
        return f"{m} min {s} s"
    if m:
        return f"{m} min"
    return f"{s} s"


def _ev(sign: str, text: str, tags: list[str], pin: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"sign": sign, "text": text, "tags": tags, "pin": pin or {}}


def _share_text(part: float, total: float) -> str:
    if part >= total:
        return f"Accounts for the whole +{total:.2f} A bus-current rise"
    return f"Accounts for +{part:.2f} A of the +{total:.2f} A bus-current rise"


def _loads(run_id: str, m: Measurements) -> dict[str, Any]:
    """Mean draw before the first command and after the warn, plus bus-current attribution."""
    t_first = min((e["time_s"] for e in m.events), default=m.t_warn)
    before = (t_first - BEFORE_S, t_first - 5.0)
    after = (m.t_warn + AFTER_FROM_S, m.t_warn + AFTER_TO_S)
    out: dict[str, Any] = {
        "before_window": [before[0], before[1]],
        "after_window": [after[0], after[1]],
        "before_label": f"{format_clock(before[0])[:5]}–{format_clock(before[1])[:5]}",
        "after_label": f"{format_clock(after[0])[:5]}–{format_clock(after[1])[:5]}",
    }
    for key, channel in (("heater", HEATER), ("payload", PAYLOAD), ("bus", BUS_I)):
        b = _mean(run_id, channel, *before)
        a = _mean(run_id, channel, *after)
        out[key] = {
            "before": round(b, 3) if b is not None else None,
            "after": round(a, 3) if a is not None else None,
        }
    for when in ("before", "after"):
        bus = out["bus"][when]
        h = out["heater"][when] or 0.0
        p = out["payload"][when] or 0.0
        out.setdefault("other", {})[when] = round(bus - h - p, 3) if bus is not None else None
    for key in ("heater", "payload", "other", "bus"):
        b, a = out[key]["before"], out[key]["after"]
        out[key]["delta"] = round(a - b, 3) if a is not None and b is not None else None
    return out


def _onsets(m: Measurements, loads: dict[str, Any]) -> dict[str, Any]:
    """When each signal moved. A load moved at its command if its draw stepped up after it."""
    out: dict[str, Any] = {"alarm": {"t": m.t_warn, "clock": format_clock(m.t_warn), "label": "warn"}}
    if m.heater_enable and (loads["heater"]["delta"] or 0) > STEP_MIN_A:
        t = m.heater_enable["time_s"]
        out["heater"] = {"t": t, "clock": format_clock(t), "label": "HEATER_B_ENABLE"}
    if m.science and (loads["payload"]["delta"] or 0) > STEP_MIN_A:
        t = m.science["time_s"]
        out["payload"] = {"t": t, "clock": format_clock(t), "label": "SCIENCE_MODE"}
    return out


def _lowest(run_id: str, channel: str, meta: dict[str, Any]) -> dict[str, Any]:
    rows = [r for r in query_channel(run_id, channel) if r["value_num"] is not None]
    if not rows:
        return {}
    above = meta.get("limit_direction") == "above"
    pick = max(rows, key=lambda r: r["value_num"]) if above else min(rows, key=lambda r: r["value_num"])
    critical = meta.get("critical_limit")
    value = pick["value_num"]
    margin = None
    if critical is not None:
        margin = (critical - value) if above else (value - critical)
    return {
        "kind": "highest" if above else "lowest",
        "value": round(value, 2),
        "clock": format_clock(pick["time_s"]),
        "t": pick["time_s"],
        "critical": critical,
        "margin": round(margin, 2) if margin is not None else None,
    }


def _lanes(alarm: str) -> list[dict[str, Any]]:
    """Signals for the "which moved first" chart: both suspect loads plus the alarm signal."""
    lanes = [
        {"id": "heater", "channel": HEATER, "label": "Heater B current", "color": "--ch-heater"},
        {"id": "payload", "channel": PAYLOAD, "label": "Payload current", "color": "--ch-payload"},
    ]
    if alarm in (HEATER, PAYLOAD):
        lanes.append({"id": "voltage", "channel": BUS_V, "label": "Bus voltage", "color": "--ch-bus"})
    elif alarm == BATT_V:
        lanes.append({"id": "voltage", "channel": BATT_V, "label": "Battery voltage", "color": "--ch-batt"})
    else:
        lanes.append({"id": "voltage", "channel": alarm, "label": "Bus voltage", "color": "--ch-bus"})
    return lanes


def _lane_of(alarm: str) -> str:
    return {HEATER: "heater", PAYLOAD: "payload"}.get(alarm, "voltage")


def _hypotheses(m: Measurements, spec: dict[str, Any], family: str, loads: dict, onsets: dict) -> list[dict]:
    hmax = m.heater_healthy_max
    pmax = m.payload_healthy
    hr, pr = m.heater_ratio, m.payload_ratio
    hv, pv = m.heater_value, m.payload_value
    bus_d = loads["bus"]["delta"]
    h_d = loads["heater"]["delta"]
    p_d = loads["payload"]["delta"]
    batt_warn = spec["channels"][BATT_V]["warn_limit"]
    batt = m.batt_num
    h_on = onsets.get("heater")
    p_on = onsets.get("payload")
    warn_t = m.t_warn
    any_guilty = (hr or 0) >= 2 or (pr or 0) >= 2

    # ── Heater B overcurrent ─────────────────────────────────────────
    heater_ev: list[dict] = []
    heater_pin_t = m.heater_enable["time_s"] if m.heater_enable else warn_t
    if hr is not None and hr >= 2:
        heater_ev.append(_ev("+", f"Draws {hv:.2f} A after switch-on, {hr:.1f}× the healthy maximum of {hmax:g} A",
                             ["OBSERVED", "DERIVED"], {"t": heater_pin_t, "lane": "heater"}))
    elif hr is not None and hr >= MARGINAL_MIN:
        heater_ev.append(_ev("+", f"Draws {hv:.2f} A, {hr:.1f}× the healthy maximum of {hmax:g} A: elevated",
                             ["OBSERVED", "DERIVED"], {"t": heater_pin_t, "lane": "heater"}))
        heater_ev.append(_ev("−", f"Below EPS-17's ≥2× prime-suspect bar ({2 * hmax:.1f} A)",
                             ["DERIVED", "DOCUMENTED"], {"t": heater_pin_t, "lane": "heater"}))
    elif hv is not None and hv > 0.3:
        heater_ev.append(_ev("−", f"Draws {hv:.2f} A, inside the healthy {spec['channels'][HEATER]['nominal_range'][0]:g}–{hmax:g} A range",
                             ["OBSERVED", "DERIVED"], {"t": heater_pin_t, "lane": "heater"}))
    else:
        heater_ev.append(_ev("−", "Heater B is off at the alarm", ["OBSERVED"], {"t": warn_t, "lane": "heater"}))
    heater_elevated = (hr or 0) >= MARGINAL_MIN
    if heater_elevated and h_on and p_on and h_on["t"] < p_on["t"]:
        heater_ev.append(_ev("+", f"Stepped up at {h_on['clock']}, {_dur(p_on['t'] - h_on['t'])} before the payload changed",
                             ["OBSERVED"], {"t": h_on["t"], "lane": "heater"}))
    elif heater_elevated and h_on and not p_on and warn_t - h_on["t"] >= 1:
        heater_ev.append(_ev("+", f"Stepped up at {h_on['clock']}, {_dur(warn_t - h_on['t'])} before the alarm",
                             ["OBSERVED"], {"t": h_on["t"], "lane": "heater"}))
    if bus_d and h_d is not None and bus_d > STEP_MIN_A:
        share = h_d / bus_d
        if share >= 0.5 and not heater_elevated:
            heater_ev.append(_ev("−", f"Its +{h_d:.2f} A rise is a normal switch-on, not an overcurrent",
                                 ["DERIVED", "DOCUMENTED"], {"part": "heater"}))
        elif share >= 0.5:
            heater_ev.append(_ev("+", _share_text(h_d, bus_d), ["DERIVED"], {"part": "heater"}))
        elif h_d > STEP_MIN_A:
            heater_ev.append(_ev("−", f"Adds only +{h_d:.2f} A of the +{bus_d:.2f} A bus-current rise",
                                 ["DERIVED"], {"part": "heater"}))
    if family == "heater":
        heater_ev.append(_ev("+", "Matches INC-0187: about 3× heater draw, payload not the load", ["DOCUMENTED"]))
    elif family == "withheld" and hr is not None and hr >= MARGINAL_MIN:
        heater_ev.append(_ev("−", f"Does not match INC-0187 (about 3× draw); this tape is {hr:.1f}×", ["DOCUMENTED", "DERIVED"]))

    # ── Payload power spike ──────────────────────────────────────────
    payload_ev: list[dict] = []
    pay_pin_t = m.science["time_s"] if m.science else warn_t
    if m.science:
        lag = warn_t - m.science["time_s"]
        when = "at the moment of the alarm" if lag < 1 else f"{_dur(lag)} before the alarm"
        payload_ev.append(_ev("+", f"Science mode began {when}", ["OBSERVED"], {"t": m.science["time_s"], "lane": "payload"}))
    mode = (m.payload_mode or {}).get("value_text") or "?"
    if pr is not None and pr >= 2:
        payload_ev.append(_ev("+", f"Draws {pv:.2f} A, {pr:.1f}× the {pmax:g} A healthy science draw",
                              ["OBSERVED", "DERIVED"], {"t": pay_pin_t + 30, "lane": "payload"}))
    elif pr is not None and pr >= MARGINAL_MIN:
        payload_ev.append(_ev("−", f"Draws {pv:.2f} A, {pr:.1f}× science draw: below the ≥2× bar",
                              ["OBSERVED", "DERIVED"], {"t": pay_pin_t + 30, "lane": "payload"}))
    elif pv is not None:
        payload_ev.append(_ev("−", f"Draws {pv:.2f} A, normal for {mode} (science ≈ {pmax:g} A)",
                              ["OBSERVED", "DERIVED"], {"t": warn_t, "lane": "payload"}))
    if bus_d and p_d is not None and bus_d > STEP_MIN_A:
        if p_d / bus_d >= 0.5:
            payload_ev.append(_ev("+", _share_text(p_d, bus_d), ["DERIVED"], {"part": "payload"}))
        else:
            payload_ev.append(_ev("−", f"Adds only +{max(p_d, 0):.2f} A and can't explain a +{bus_d:.2f} A rise",
                                  ["DERIVED", "DOCUMENTED"], {"part": "payload"}))
    if h_on and p_on and h_on["t"] < p_on["t"] and (hr or 0) >= MARGINAL_MIN:
        payload_ev.append(_ev("−", "Heater B was already elevated before the payload switched",
                              ["OBSERVED"], {"t": h_on["t"], "lane": "heater"}))
    if family == "payload":
        payload_ev.append(_ev("+", "Matches INC-0191: payload overcurrent on science-mode entry", ["DOCUMENTED"]))

    # ── Battery resistance degradation ───────────────────────────────
    battery_ev: list[dict] = []
    if batt is not None:
        if batt < batt_warn:
            battery_ev.append(_ev("+", f"Battery voltage is {batt:.2f} V at the alarm, below its {batt_warn:g} V warn",
                                  ["OBSERVED"], {"t": warn_t, "lane": "voltage"}))
        else:
            battery_ev.append(_ev("−", f"Battery voltage is {batt:.2f} V, above its {batt_warn:g} V warn",
                                  ["OBSERVED"], {"t": warn_t, "lane": "voltage"}))
    if any_guilty:
        battery_ev.append(_ev("−", "A load is ≥2× healthy, which explains the sag without a battery problem",
                              ["DERIVED", "DOCUMENTED"], {"part": "heater" if (hr or 0) >= 2 else "payload"}))
    elif (hr or 0) < MARGINAL_MIN and (pr or 0) < MARGINAL_MIN:
        battery_ev.append(_ev("+", "Heater and payload currents are both healthy, so load doesn't explain the sag",
                              ["DERIVED", "DOCUMENTED"], {"t": warn_t, "lane": "heater"}))
    else:
        battery_ev.append(_ev("−", "A load is elevated, so the sag may be load rather than the pack",
                              ["DERIVED"], {"t": warn_t, "lane": "heater"}))
    if family == "battery":
        battery_ev.append(_ev("+", "Matches INC-0162: pack sag under a healthy heater enable", ["DOCUMENTED"]))

    def verdict(card: str) -> str:
        if family == card:
            return "leading"
        if family == "withheld":
            closest = "heater" if (hr or 0) >= (pr or 0) else "payload"
            return "below_bar" if card == closest else "ruled_out"
        if family == "open":
            return "insufficient"
        return "ruled_out"

    def reason(evs: list[dict], v: str) -> str:
        sign = "+" if v == "leading" else "−"
        pick = (
            next((e for e in evs if e["sign"] == sign and "DERIVED" in e["tags"]), None)
            or next((e for e in evs if e["sign"] == sign), None)
            or (evs[0] if evs else None)
        )
        return pick["text"] if pick else ""

    cards = [
        {"id": "heater", "name": "Heater B overcurrent", "fault": "FAULT-001", "procedure": "EPS-17",
         "color": "--ch-heater", "evidence": heater_ev},
        {"id": "payload", "name": "Payload power spike", "fault": "FAULT-002", "procedure": "PAY-04",
         "color": "--ch-payload", "evidence": payload_ev},
        {"id": "battery", "name": "Battery aging", "fault": "FAULT-003", "procedure": "EPS-09",
         "color": "--ch-batt", "evidence": battery_ev},
    ]
    footers = {
        ("heater", "leading"): "Meets EPS-17 step 4 (≥2× healthy draw)",
        ("payload", "leading"): "Meets PAY-04 step 4 (≥2× science draw)",
        ("battery", "leading"): "EPS-09 step 5: loads healthy, sag is on the pack",
        ("heater", "below_bar"): "EPS-17 step 4 not met: a clue, not a close",
        ("payload", "below_bar"): "PAY-04 step 4 not met: a clue, not a close",
        ("payload", "ruled_out"): "EPS-17 step 5: a confounder, not a cause" if m.science else "Payload current is healthy",
        ("heater", "ruled_out"): "PAY-04 step 5 / EPS-09 step 5: do not inhibit Heater B",
        ("battery", "ruled_out"): "Would need healthy loads and a sag anyway",
    }
    for card in cards:
        v = verdict(card["id"])
        card["verdict"] = v
        card["reason"] = reason(card["evidence"], v)
        card["footer"] = footers.get((card["id"], v), "")
    order = {"leading": 0, "below_bar": 1, "insufficient": 2, "ruled_out": 3}
    cards.sort(key=lambda c: order[c["verdict"]])
    return cards


def _headline(m: Measurements, family: str, loads: dict) -> tuple[str, str]:
    hr, pr = m.heater_ratio or 0, m.payload_ratio or 0
    if family == "heater":
        if m.science:
            lag = _dur(m.t_warn - m.science["time_s"])
            return (
                "Bus voltage dropped after Heater B came on",
                f"The payload entered science mode {lag} before the alarm, so it looks guilty. "
                f"The evidence says Heater B was already drawing {hr:.1f}× its normal current.",
            )
        return (
            "Bus voltage dropped after Heater B came on",
            f"Heater B drew {hr:.1f}× its normal current from the moment it switched on. The payload stayed in standby.",
        )
    if family == "payload":
        return (
            "Payload current spiked when science mode started",
            f"The payload is drawing {pr:.1f}× its healthy science current. Heater B isn't the load.",
        )
    if family == "battery":
        hv = loads["heater"]["after"] or 0
        return (
            "Battery voltage sagged under a healthy load",
            f"Heater B switched on at a normal {hv:.2f} A, yet the battery crossed its warn. "
            "The loads are healthy, so the pack is the suspect.",
        )
    if family == "withheld":
        return (
            "Bus voltage dipped, but no load clears the 2× bar",
            f"Heater B is drawing {hr:.1f}× normal: elevated, not conclusive. "
            "Science mode is a confounder. ORBIT recommends holding until the evidence clears the bar.",
        )
    return ("Alarm with no clear load", "No load is elevated and the battery is above its warn.")


def _recommendation(family: str) -> dict[str, str]:
    return {
        "heater": {"option": "heater_off", "label": "Turn off Heater B",
                   "detail": "Inhibit Heater B and watch bus voltage recover (EPS-17 step 6). Do not safe the payload first."},
        "payload": {"option": "payload_safe", "label": "Safe the payload",
                    "detail": "Return the payload to STANDBY and watch payload current fall (PAY-04 step 6). Do not inhibit Heater B."},
        "battery": {"option": "hold", "label": "Hold · continue EPS-09",
                    "detail": "Continue the battery checkout. Do not inhibit Heater B and do not safe the payload: both are healthy."},
        "withheld": {"option": "hold", "label": "Hold · do not command",
                     "detail": "No load crosses the ≥2× bar (EPS-17 step 4). Keep watching until one does or ops authorizes an isolation test."},
        "open": {"option": "hold", "label": "Hold",
                 "detail": "No load to inhibit. Do not command until evidence clears the bar."},
    }[family]


def _charts(family: str, m: Measurements, loads: dict, onsets: dict) -> dict[str, Any]:
    h_on, p_on = onsets.get("heater"), onsets.get("payload")
    if h_on and p_on:
        lead = p_on["t"] - h_on["t"]
        first = "Heater B" if lead > 0 else "the payload"
        lanes_cap = (
            f"Heater B stepped up at <b>{h_on['clock']}</b>, <b>{_dur(lead)}</b> "
            f"{'before' if lead > 0 else 'after'} the payload changed mode. "
            f"The alarm followed at <b>{onsets['alarm']['clock']}</b>."
        )
        why = f"Two loads changed before the alarm, so the order matters: {first} moved first."
    elif h_on and m.t_warn - h_on["t"] < 1:
        lanes_cap = (f"Heater B switched on at <b>{h_on['clock']}</b> and the alarm fired on the same sample. "
                     "The payload did not change.")
        why = "The alarm fired the moment a load switched on, so the chart compares the load with the voltage."
    elif h_on:
        lanes_cap = (f"Heater B stepped up at <b>{h_on['clock']}</b>. The alarm followed "
                     f"<b>{_dur(m.t_warn - h_on['t'])}</b> later. The payload did not change.")
        why = "Only one load changed before the alarm. The chart shows it leading the alarm."
    elif p_on:
        lanes_cap = (f"The payload entered science mode at <b>{p_on['clock']}</b> and its current stepped up. "
                     "Heater B did not change.")
        why = "Only the payload changed before the alarm."
    else:
        lanes_cap = (f"No load stepped up before the alarm at <b>{onsets['alarm']['clock']}</b>. "
                     "The signal sagged on its own.")
        why = "No load stepped up, so the chart shows the alarm signal falling with loads flat."

    bus = loads["bus"]
    parts = []
    if bus["delta"] is not None:
        parts.append(f"Bus current went from <b>{bus['before']:.2f} A</b> to <b>{bus['after']:.2f} A</b> "
                     f"(<b>{'+' if bus['delta'] >= 0 else ''}{bus['delta']:.2f} A</b>).")
        contrib = [("Heater B", loads["heater"]["delta"]), ("the payload", loads["payload"]["delta"])]
        named = [f"{name} <b>{'+' if d >= 0 else ''}{d:.2f} A</b>" for name, d in contrib if d is not None and abs(d) >= 0.05]
        if named:
            parts.append("Of that, " + " and ".join(named) + ".")
    breakdown_why = {
        "battery": "Shows both loads stayed at healthy draw, which points at the pack.",
        "withheld": "Shows how much each load added, and that neither is decisive.",
    }.get(family, "Shows how much each load added to the bus.")
    return {
        "items": [
            {"kind": "lanes", "title": "Which signal moved first", "caption": lanes_cap, "tags": ["OBSERVED"], "why": why},
            {"kind": "breakdown", "title": "Where did the power go?", "caption": " ".join(parts),
             "tags": ["DERIVED"], "why": breakdown_why},
        ],
    }


OPTION_LABELS = {"heater_off": "Turn off Heater B", "payload_safe": "Safe the payload", "hold": "Hold"}
RECOMMENDED_OPTION = {"heater": "heater_off", "payload": "payload_safe"}
SHORT = {BUS_V: "Bus voltage", BATT_V: "Battery voltage", PAYLOAD: "Payload current", HEATER: "Heater current"}


def _option_note(family: str, option: str) -> str | None:
    return {
        ("withheld", "heater_off"): "This is EPS-17's isolation test. It needs ops authorization; if the bus recovers, Heater B can be named.",
        ("battery", "heater_off"): "Shedding a healthy load lifts the voltage but leaves the pack degraded. EPS-09 step 5: don't inhibit healthy loads.",
        ("battery", "payload_safe"): "The payload is healthy. EPS-09 step 5: don't safe it.",
        ("payload", "heater_off"): "Heater B isn't drawing. PAY-04 step 5: don't inhibit it.",
        ("heater", "payload_safe"): "EPS-17 step 5: the payload can't explain the step.",
        ("battery", "hold"): "EPS-09 step 7: continue the battery checkout offline.",
        ("withheld", "hold"): "EPS-17 step 4 not met. Keep watching Heater B current.",
    }.get((family, option))


def _option_text(option: str, o: dict[str, Any], channel: str, unit: str, meta: dict[str, Any]) -> str:
    name = SHORT.get(channel, channel)
    if o.get("clears"):
        return f"{name} back to {o['first_value']:g} {unit} at the next sample and {o['value_10min']:g} {unit} ten minutes later."
    crit = meta.get("critical_limit")
    tail = ""
    if crit is not None:
        margin = (o["worst"] - crit) if meta.get("limit_direction") == "below" else (crit - o["worst"])
        tail = f" Worst {o['worst']:g} {unit}, {abs(margin):.2f} {unit} {'above' if margin >= 0 else 'past'} critical." \
            if meta.get("limit_direction") == "below" else f" Worst {o['worst']:g} {unit}."
    if option == "hold":
        return f"{name} stays in warn: {o['value_10min']:g} {unit} ten minutes later.{tail}"
    lim, d = meta["warn_limit"], meta.get("limit_direction")
    first_ok = o["first_value"] > lim if d == "below" else o["first_value"] < lim
    if first_ok:
        return f"{name} is {o['first_value']:g} {unit} at the next sample but slips back into warn.{tail}"
    return f"{name} only reaches {o['first_value']:g} {unit} and is {o['value_10min']:g} {unit} ten minutes later.{tail}"


def _simulation(run_id: str, alarm: str, family: str, m: Measurements, spec: dict[str, Any], onsets: dict) -> dict | None:
    """What-if replay, healthy reference, and a preview of each option. None if the tape has no recipe."""
    if not sim.supports(run_id):
        return None
    tape = sim.source_tape(run_id)
    meta = spec["channels"][alarm]
    unit = meta.get("unit") or ""
    limit, direction = meta["warn_limit"], meta["limit_direction"]
    t_warn = m.t_warn
    t_first = min((e["time_s"] for e in m.events), default=t_warn)
    actual = sim.replay(tape)
    t_end = float(actual["time_s"].max())
    view0, view1 = max(t_first - 180.0, float(actual["time_s"].min())), min(t_warn + 600.0, t_end)

    out: dict[str, Any] = {"tape": tape, "channel": alarm, "unit": unit, "warn": limit, "direction": direction,
                           "critical": meta.get("critical_limit")}

    if family in ("heater", "payload", "battery"):
        healthy = sim.replay(tape, remove_fault=True)
        wi = sim.outcome(healthy, alarm, view0, limit, direction, settle_s=0)
        suspect = {"heater": "Heater B", "payload": "the payload", "battery": "the battery pack"}[family]
        out["whatif"] = {
            "removed": suspect,
            "clears": wi["clears"],
            "worst": wi["worst"],
            "window": [view0, view1],
            "actual": sim.series(actual, alarm, view0, view1),
            "healthy": sim.series(healthy, alarm, view0, view1),
            "caption": (
                f"Replayed with a healthy {suspect.replace('the ', '')}, the worst reading is <b>{wi['worst']:g} {unit}</b>, "
                + ("which never crosses the warn." if wi["clears"] else "which still crosses the warn.")
            ),
        }
        load_ch = {"heater": HEATER, "payload": PAYLOAD}.get(family)
        onset = onsets.get(family)
        if load_ch and onset:
            h0, h1 = max(onset["t"] - 120.0, view0), min(onset["t"] + 360.0, t_end)
            healthy_val = float(healthy[(healthy["time_s"] >= onset["t"] + 60) & (healthy["time_s"] <= onset["t"] + 240)][load_ch].mean())
            today_val = float(actual[(actual["time_s"] >= onset["t"] + 60) & (actual["time_s"] <= onset["t"] + 240)][load_ch].mean())
            out["healthy"] = {
                "channel": load_ch,
                "window": [h0, h1],
                "onset": onset,
                "actual": sim.series(actual, load_ch, h0, h1),
                "healthy": sim.series(healthy, load_ch, h0, h1),
                "nominal": spec["channels"][load_ch]["nominal_range"],
                "bar": 2 * spec["channels"][load_ch]["nominal_range"][1],
                "caption": f"Same command, same moment. Healthy draw is <b>{healthy_val:.2f} A</b>; today it is <b>{today_val:.2f} A</b>.",
            }

    t_dec = round((t_warn + 120.0) / 5.0) * 5.0
    recommended = RECOMMENDED_OPTION.get(family, "hold")
    options = []
    p0 = max(t_warn - 120.0, float(actual["time_s"].min()))
    for opt, cmd in sim.OPTION_COMMANDS.items():
        df = sim.replay(tape, extra=((t_dec, cmd),) if cmd else (), end_s=t_dec + sim.PREVIEW_HORIZON_S)
        o = sim.outcome(df, alarm, t_dec, limit, direction)
        result = "clears" if o["clears"] else ("stays" if opt == "hold" else "fails")
        options.append({
            "id": opt,
            "label": OPTION_LABELS[opt],
            "recommended": opt == recommended,
            "result": result,
            "outcome": o,
            "text": _option_text(opt, o, alarm, unit, meta),
            "note": _option_note(family, opt),
            "series": sim.series(df, alarm, t_dec - 5.0, t_dec + sim.PREVIEW_HORIZON_S),
        })
    out["decision"] = {
        "t": t_dec,
        "clock": format_clock(t_dec),
        "before": sim.series(actual, alarm, p0, t_dec),
        "window": [p0, t_dec + sim.PREVIEW_HORIZON_S],
        "options": options,
    }
    return out


def _attach_proofs(hyps: list[dict], family: str, simulation: dict | None) -> None:
    """Hang the replay charts off the evidence lines that cite them."""
    if not simulation or "whatif" not in simulation:
        return
    wi = simulation["whatif"]
    for card in hyps:
        if card["verdict"] == "leading":
            ratio_line = next((e for e in card["evidence"] if e["sign"] == "+" and "×" in e["text"]), None)
            if "healthy" in simulation and ratio_line:
                ratio_line["proof"] = "healthy"
            clears = wi["clears"]
            subject = {"heater": "heater", "payload": "payload", "battery": "pack"}[family]
            card["evidence"].append(_ev(
                "+" if clears else "−",
                f"With a healthy {subject} in the replay, there is no alarm" if clears
                else f"Even with a healthy {subject} in the replay, the alarm still fires",
                ["DERIVED", "SIMULATED"], {"t": None},
            ))
            card["evidence"][-1]["proof"] = "whatif"
        elif card["id"] == "battery" and family in ("heater", "payload") and wi["clears"]:
            card["evidence"].append(_ev(
                "−", f"Voltage holds when {wi['removed']} is healthy in the replay", ["DERIVED", "SIMULATED"], {"t": None},
            ))
            card["evidence"][-1]["proof"] = "whatif"


def build_brief(run_id: str, alarm: str) -> dict[str, Any]:
    return _build_brief_cached(run_id, alarm)


@lru_cache(maxsize=64)
def _build_brief_cached(run_id: str, alarm: str) -> dict[str, Any]:
    spec = load_and_validate()
    tools = Tools(None, spec)  # tools read files; no DB needed
    m = measure(tools, spec, run_id, alarm)
    meta = spec["channels"][alarm]
    if m.crossing is None:
        return {"run_id": run_id, "alarm": alarm, "family": "open", "no_crossing": True,
                "headline": f"No {alarm} warn crossing on this tape", "lede": "", "tool_trail": tools.trail}

    family = classify(m, spec)
    key, label = HYPOTHESIS_BY_FAMILY[family]
    procedure_id, prior_id = PROCEDURE_BY_FAMILY[family]
    tools.get_doc(procedure_id)
    if family in ("heater", "payload", "battery", "withheld"):
        tools.get_doc(prior_id)

    loads = _loads(run_id, m)
    onsets = _onsets(m, loads)
    hyps = _hypotheses(m, spec, family, loads, onsets)
    simulation = _simulation(run_id, alarm, family, m, spec, onsets)
    _attach_proofs(hyps, family, simulation)
    headline, lede = _headline(m, family, loads)
    step_proc, step_no, step_text = STEP_BY_FAMILY[family]

    ratio_line = None
    if family in ("heater", "withheld") and m.heater_ratio:
        ratio_line = f"{m.heater_ratio:.1f}× healthy draw"
    elif family == "payload" and m.payload_ratio:
        ratio_line = f"{m.payload_ratio:.1f}× science draw"
    elif family == "battery":
        ratio_line = "loads healthy"

    trail = list(tools.trail)
    if m.heater_ratio is not None:
        trail.append({"tool": "ratio", "args": f"{HEATER} ÷ healthy max {m.heater_healthy_max:g} A",
                      "out": f"{m.heater_value:.2f} A → {m.heater_ratio:.1f}×", "tag": "DERIVED"})
    if m.payload_ratio is not None:
        trail.append({"tool": "ratio", "args": f"{PAYLOAD} ÷ science {m.payload_healthy:g} A",
                      "out": f"{m.payload_value:.2f} A → {m.payload_ratio:.1f}×", "tag": "DERIVED"})
    trail.append({"tool": "classify", "args": "EPS-17 / PAY-04 / EPS-09 bars",
                  "out": f"{label}", "tag": "DERIVED"})
    if simulation:
        unit = simulation["unit"]
        if "whatif" in simulation:
            wi = simulation["whatif"]
            trail.append({"tool": "what_if", "args": f"replay {simulation['tape']} with {wi['removed']} healthy",
                          "out": f"worst {wi['worst']:g} {unit} · {'no warn' if wi['clears'] else 'still warns'}",
                          "tag": "SIMULATED"})
        dec = simulation["decision"]
        trail.append({"tool": "preview", "args": f"{len(dec['options'])} options from {dec['clock']}",
                      "out": " · ".join(f"{o['label'].lower()} {o['outcome']['first_value']:g} {unit}" for o in dec["options"]),
                      "tag": "SIMULATED"})

    sealed = read_sealed_meta(run_id) if run_id.startswith("sealed_") else None
    return {
        "run_id": run_id,
        "alarm": alarm,
        "family": family,
        "hypothesis_key": key,
        "headline": headline,
        "lede": lede,
        "facts": {
            "alarm": {"channel": alarm, "value": round(m.crossing["value_num"], 2), "unit": meta.get("unit"),
                      "clock": format_clock(m.t_warn), "t": m.t_warn, "warn": meta.get("warn_limit"),
                      "direction": meta.get("limit_direction")},
            "extreme": {**_lowest(run_id, alarm, meta), "unit": meta.get("unit")},
            "leading": {"label": LEADING_LABEL[family], "sub": ratio_line, "family": family},
            "procedure": {"id": step_proc, "step": step_no, "sub": step_text},
        },
        "recommendation": _recommendation(family),
        "events": [{"t": e["time_s"], "clock": format_clock(e["time_s"]), "detail": e["detail"], "channel": e["channel"]}
                   for e in m.events],
        "lanes": _lanes(alarm),
        "alarm_lane": _lane_of(alarm),
        "loads": loads,
        "onsets": onsets,
        "hypotheses": hyps,
        "charts": _charts(family, m, loads, onsets),
        "simulation": simulation,
        "tool_trail": trail,
        "sealed": {
            "id": run_id,
            "source": (sealed or {}).get("source_run_id") or run_id,
            "t0": (sealed or {}).get("t0"),
            "t1": (sealed or {}).get("t1"),
            "clock0": format_clock(sealed["t0"]) if sealed else None,
            "clock1": format_clock(sealed["t1"]) if sealed else None,
        },
    }
