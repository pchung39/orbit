"""Eval cases. Spec says score fault #1 before adding FAULT-002/003."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Case:
    id: str
    alarm: str
    label: str
    """heater = HEATER_B_OVERCURRENT is the expected close."""
    root_cause: str
    """If set, the report must treat this as a confounder, not the cause."""
    confounder: str | None
    procedure: str
    similar: str | None
    action: str


CASES: tuple[Case, ...] = (
    Case(
        id="eps204",
        alarm="EPS.bus_voltage",
        label="heater overcurrent + SCIENCE_MODE confounder",
        root_cause="heater",
        confounder="SCIENCE_MODE",
        procedure="EPS-17",
        similar="INC-0187",
        action="inhibit_heater_b",
    ),
    Case(
        id="fault1",
        alarm="EPS.bus_voltage",
        label="heater overcurrent, payload stays STANDBY",
        root_cause="heater",
        confounder=None,
        procedure="EPS-17",
        similar="INC-0187",
        action="inhibit_heater_b",
    ),
)
