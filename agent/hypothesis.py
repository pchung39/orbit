"""Canonical hypothesis identity for a tape + alarm pair.

Shared by investigate, feedback capture, closeout, and eval alignment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.tools import Tools
from simulator.simulate import load_and_validate
from storage.store import connect, init_schema


def _num(row: dict | None) -> float | None:
    if row is None:
        return None
    return row.get("value_num")


HYPOTHESIS_BY_FAMILY: dict[str, tuple[str, str]] = {
    "heater": (
        "HEATER_B_OVERCURRENT",
        "HEATER_B_OVERCURRENT (FAULT-001): Heater B draws ~3× when commanded ON.",
    ),
    "payload": (
        "PAYLOAD_POWER_SPIKE",
        "PAYLOAD_POWER_SPIKE (FAULT-002): payload current is ~3× the healthy science baseline.",
    ),
    "battery": (
        "BATTERY_RESISTANCE_DEGRADATION",
        "BATTERY_RESISTANCE_DEGRADATION (FAULT-003): pack voltage sagged under a healthy load.",
    ),
    "open": (
        "UNKNOWN",
        "Load currents are not ≥2× healthy. Root cause still open.",
    ),
}


@dataclass(frozen=True)
class Hypothesis:
    key: str
    label: str
    family: str


def classify_family(tools: Tools, spec: dict[str, Any], run_id: str, alarm_channel: str) -> str:
    """Same family rules as investigate_rules."""
    crossing = tools.first_warn(run_id, alarm_channel)
    if crossing is None:
        return "open"

    t_warn = crossing["time_s"]
    heater_now = tools.sample(run_id, "THM.heater_b_current", t_warn)
    payload_now = tools.sample(run_id, "PAY.payload_current", t_warn)
    batt_v = tools.sample(run_id, "EPS.battery_voltage", t_warn)

    heater_nominal = spec["channels"]["THM.heater_b_current"]["nominal_range"]
    heater_healthy_max = heater_nominal[1]
    heater_value = _num(heater_now)
    heater_ratio = (heater_value / heater_healthy_max) if heater_value else None

    payload_healthy_science = spec["channels"]["PAY.payload_current"]["nominal_range"][1]
    payload_value = _num(payload_now)
    payload_ratio = (payload_value / payload_healthy_science) if payload_value else None

    heater_guilty = heater_ratio is not None and heater_ratio >= 2
    payload_guilty = (not heater_guilty) and payload_ratio is not None and payload_ratio >= 2
    battery_family = (not heater_guilty) and (not payload_guilty) and (
        alarm_channel == "EPS.battery_voltage"
        or (
            batt_v is not None
            and _num(batt_v) is not None
            and _num(batt_v) < spec["channels"]["EPS.battery_voltage"]["warn_limit"]
        )
    )

    if heater_guilty:
        return "heater"
    if payload_guilty:
        return "payload"
    if battery_family:
        return "battery"
    return "open"


def hypothesis_for(run_id: str, alarm_channel: str) -> Hypothesis:
    spec = load_and_validate()
    conn = connect()
    init_schema(conn)
    tools = Tools(conn, spec)
    family = classify_family(tools, spec, run_id, alarm_channel)
    key, label = HYPOTHESIS_BY_FAMILY[family]
    return Hypothesis(key=key, label=label, family=family)


def family_matches_root_cause(family: str, root_cause: str) -> bool:
    return family == root_cause
