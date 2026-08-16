"""Named runs on top of the sim core: EPS-204, fault #1, INC-0187 source.

Does not compute physics. It schedules commands, injects faults, and checks
the demo script's timestamps against a finished dataframe.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pandas as pd

from simulator.simulate import (
    ActiveFault,
    Assumptions,
    initial_state,
    run_simulation,
)


def clock_to_s(clock: str) -> float:
    parts = [int(p) for p in clock.split(":")]
    h, m = parts[0], parts[1]
    s = parts[2] if len(parts) > 2 else 0
    return float(h * 3600 + m * 60 + s)


def format_clock(t_s: float) -> str:
    t = int(round(t_s)) % 86400
    return f"{t // 3600:02d}:{(t % 3600) // 60:02d}:{t % 60:02d}"


def script_actions(spec: dict[str, Any]) -> list[tuple[float, str]]:
    """Command / mode_change rows from the demo script. Breaches are outcomes."""
    actions: list[tuple[float, str]] = []
    for event in spec["demo_scenario_EPS204"]["script"]:
        if event["event"] in ("command", "mode_change"):
            actions.append((clock_to_s(event["t"]), event["action"]))
    return actions


def heater_overcurrent_fault(spec: dict[str, Any], onset_s: float) -> ActiveFault:
    fault = spec["fault_library"]["HEATER_B_OVERCURRENT"]
    return ActiveFault(
        name="HEATER_B_OVERCURRENT",
        onset_s=onset_s,
        channel="THM.heater_b_current",
        multiplier=float(fault["fault_multiplier_on_heater_current"]),
    )


def run_heater_fault(
    spec: dict[str, Any],
    start_clock: str,
    end_clock: str,
    heater_enable: str,
    science_mode: str | None = None,
    epoch: datetime | None = None,
) -> pd.DataFrame:
    """Heater-overcurrent window. Optional SCIENCE_MODE for the EPS-204 confounder."""
    assumptions = Assumptions(
        initial_soc_pct=100.0,
        t_batt_init_c=18.0,
        t_heater_init_c=18.0,
        epoch=epoch or Assumptions().epoch,
    )
    start_s = clock_to_s(start_clock)
    commands = [(clock_to_s(heater_enable), "HEATER_B_ENABLE")]
    if science_mode:
        commands.append((clock_to_s(science_mode), "SCIENCE_MODE"))
    return run_simulation(
        spec,
        duration_s=clock_to_s(end_clock) - start_s,
        assumptions=assumptions,
        faults=[heater_overcurrent_fault(spec, clock_to_s(heater_enable))],
        state=initial_state(assumptions, t_s=start_s),
        commands=commands,
    )


def run_eps204(spec: dict[str, Any], with_science_mode: bool = True) -> pd.DataFrame:
    science = "14:31:52" if with_science_mode else None
    return run_heater_fault(spec, "14:00:00", "14:45:00", "14:29:44", science)


def run_inc0187(spec: dict[str, Any]) -> pd.DataFrame:
    """Prior-day heater overcurrent, no payload confounder — source for INC-0187."""
    epoch = datetime(2026, 3, 11, tzinfo=timezone.utc)
    return run_heater_fault(
        spec,
        start_clock="01:30:00",
        end_clock="02:15:00",
        heater_enable="01:52:00",
        science_mode=None,
        epoch=epoch,
    )


def _first_beyond(df: pd.DataFrame, channel: str, limit: float, direction: str) -> pd.Series | None:
    if direction == "below":
        hit = df[df[channel] < limit]
    else:
        hit = df[df[channel] > limit]
    if hit.empty:
        return None
    return hit.iloc[0]


def report_eps204(df: pd.DataFrame, spec: dict[str, Any]) -> str:
    """Compare actual crossings to the demo script. Spec times are the target."""
    lines = ["EPS-204 event check (spec time → first matching sample)"]
    for event in spec["demo_scenario_EPS204"]["script"]:
        t_spec = clock_to_s(event["t"])
        channel = event["channel"]
        if event["event"] in ("command", "mode_change"):
            row = df[df["time_s"] >= t_spec].iloc[0]
            lines.append(
                f"  {event['t']} {event['action']:16s}  sample {format_clock(row['time_s'])}"
                f"  {channel}={row[channel]}"
            )
            continue
        meta = spec["channels"][channel]
        limit = meta.get("warn_limit")
        direction = meta.get("limit_direction", "above")
        if event["event"] == "threshold_breach" and limit is not None:
            row = _first_beyond(df, channel, float(limit), direction)
            if row is None:
                lines.append(f"  {event['t']} {channel} warn {limit}  NOT CROSSED")
            else:
                delta = row["time_s"] - t_spec
                lines.append(
                    f"  {event['t']} {channel} warn {limit}  first {format_clock(row['time_s'])}"
                    f"  ({delta:+.0f}s)  value={row[channel]:.3f}"
                )
            continue
        if event["event"] == "trend_start":
            window = df[(df["time_s"] >= t_spec - 60) & (df["time_s"] <= t_spec + 60)]
            slope = (window[channel].iloc[-1] - window[channel].iloc[0]) / max(
                window["time_s"].iloc[-1] - window["time_s"].iloc[0], 1.0
            )
            lines.append(
                f"  {event['t']} {channel} trend  slope={slope:+.4f} /s"
                f"  {'rising' if slope > 0 else 'NOT rising'}"
            )
    return "\n".join(lines)
