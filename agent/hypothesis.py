"""Canonical hypothesis identity for a tape + alarm pair.

Shared by investigate, feedback capture, closeout, and eval alignment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.tools import Tools
from simulator.simulate import load_and_validate
from storage.store import connect, init_schema

MARGINAL_MIN = 1.3


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
    "withheld": (
        "WITHHELD",
        "Hold — do not command (EPS-17 step 4 threshold not met).",
    ),
    "open": (
        "OPEN",
        "No ≥2× load and no withheld signature on this tape.",
    ),
}


@dataclass(frozen=True)
class Hypothesis:
    key: str
    label: str
    family: str


@dataclass
class Measurements:
    """Everything the rules investigator reads off the tape before deciding.

    Tool calls run in a fixed order so the tool log (and the report) stay stable.
    """

    run_id: str
    alarm: str
    crossing: dict[str, Any] | None
    t_warn: float | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    heater_enable: dict[str, Any] | None = None
    science: dict[str, Any] | None = None
    heater_now: dict[str, Any] | None = None
    payload_now: dict[str, Any] | None = None
    payload_mode: dict[str, Any] | None = None
    bus_i: dict[str, Any] | None = None
    heater_temp: dict[str, Any] | None = None
    batt_v: dict[str, Any] | None = None
    heater_at_cmd: dict[str, Any] | None = None
    heater_healthy_max: float = 0.0
    payload_healthy: float = 0.0
    heater_value: float | None = None
    heater_ratio: float | None = None
    payload_value: float | None = None
    payload_ratio: float | None = None

    @property
    def batt_num(self) -> float | None:
        return _num(self.batt_v)


def measure(tools: Tools, spec: dict[str, Any], run_id: str, alarm_channel: str) -> Measurements:
    crossing = tools.first_warn(run_id, alarm_channel)
    m = Measurements(run_id=run_id, alarm=alarm_channel, crossing=crossing)
    m.heater_healthy_max = spec["channels"]["THM.heater_b_current"]["nominal_range"][1]
    m.payload_healthy = spec["channels"]["PAY.payload_current"]["nominal_range"][1]
    if crossing is None:
        return m

    t_warn = crossing["time_s"]
    m.t_warn = t_warn
    m.events = tools.events_before(run_id, t_warn, window_s=600.0)
    m.heater_enable = next((e for e in m.events if e["detail"] == "HEATER_B_ENABLE"), None)
    m.science = next((e for e in m.events if e["detail"] == "SCIENCE_MODE"), None)

    m.heater_now = tools.sample(run_id, "THM.heater_b_current", t_warn)
    m.payload_now = tools.sample(run_id, "PAY.payload_current", t_warn)
    m.payload_mode = tools.sample(run_id, "PAY.mode", t_warn)
    m.bus_i = tools.sample(run_id, "EPS.bus_current", t_warn)
    m.heater_temp = tools.sample(run_id, "THM.heater_b_temperature", t_warn)
    m.batt_v = tools.sample(run_id, "EPS.battery_voltage", t_warn)
    m.heater_at_cmd = (
        tools.sample(run_id, "THM.heater_b_current", m.heater_enable["time_s"], after=True)
        if m.heater_enable
        else None
    )

    m.heater_value = _num(m.heater_at_cmd) or _num(m.heater_now)
    m.heater_ratio = (m.heater_value / m.heater_healthy_max) if m.heater_value else None
    m.payload_value = _num(m.payload_now)
    m.payload_ratio = (m.payload_value / m.payload_healthy) if m.payload_value else None
    return m


def classify(m: Measurements, spec: dict[str, Any]) -> str:
    """The one family decision. investigate_rules, feedback, and the case brief all use it."""
    if m.crossing is None:
        return "open"
    heater_guilty = m.heater_ratio is not None and m.heater_ratio >= 2
    payload_guilty = (not heater_guilty) and m.payload_ratio is not None and m.payload_ratio >= 2
    heater_marginal = m.heater_ratio is not None and MARGINAL_MIN <= m.heater_ratio < 2
    payload_marginal = m.payload_ratio is not None and MARGINAL_MIN <= m.payload_ratio < 2
    loads_elevated = heater_guilty or payload_guilty or heater_marginal or payload_marginal
    battery_family = (not heater_guilty) and (not payload_guilty) and (
        m.alarm == "EPS.battery_voltage"
        or (
            not loads_elevated
            and m.batt_num is not None
            and m.batt_num < spec["channels"]["EPS.battery_voltage"]["warn_limit"]
        )
    )
    if heater_guilty:
        return "heater"
    if payload_guilty:
        return "payload"
    if battery_family:
        return "battery"
    if m.events and (heater_marginal or payload_marginal):
        return "withheld"
    return "open"


# Procedure and authored prior that govern each family.
PROCEDURE_BY_FAMILY: dict[str, tuple[str, str]] = {
    "heater": ("EPS-17", "INC-0187"),
    "payload": ("PAY-04", "INC-0191"),
    "battery": ("EPS-09", "INC-0162"),
    "withheld": ("EPS-17", "INC-0187"),
    "open": ("EPS-17", "INC-0187"),
}


def classify_family(tools: Tools, spec: dict[str, Any], run_id: str, alarm_channel: str) -> str:
    return classify(measure(tools, spec, run_id, alarm_channel), spec)


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
