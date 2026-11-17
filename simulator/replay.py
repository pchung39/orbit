"""What-if replays and fix previews for a case tape.

Every archive tape is a seeded simulator run, so re-running its recipe with the
same seed reproduces the tape sample-for-sample. Changing one thing (remove the
suspect fault, or add an operator command at a decision time) then shows what
would have happened. Nothing here touches the spacecraft.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import pandas as pd

from simulator.scenarios import (
    clock_to_s,
    format_clock,
    marginal_heater_fault,
    run_battery_fault,
    run_heater_fault,
    run_payload_fault,
)
from simulator.simulate import load_and_validate
from storage.evidence import read_sealed_meta

# How each archive tape was generated. Mirrors the run_* wrappers in scenarios.py.
RECIPES: dict[str, dict[str, Any]] = {
    "eps204": {"kind": "heater", "start": "14:00:00", "end": "14:45:00", "enable": "14:29:44", "science": "14:31:52"},
    "fault1": {"kind": "heater", "start": "14:00:00", "end": "14:45:00", "enable": "14:29:44", "science": None},
    "marg001": {"kind": "heater", "start": "14:00:00", "end": "14:50:00", "enable": "14:29:44", "science": "14:31:52",
                "marginal": 1.75, "soc": 72.0},
    "pay002": {"kind": "payload", "start": "10:00:00", "end": "10:40:00", "science": "10:12:00"},
    "batt003": {"kind": "battery", "start": "00:00:00", "end": "00:45:00", "enable": "00:10:00"},
}

OPTION_COMMANDS = {
    "heater_off": "HEATER_B_DISABLE",
    "payload_safe": "PAYLOAD_STANDBY",
    "hold": None,
}

PREVIEW_HORIZON_S = 15 * 60.0


def source_tape(run_id: str) -> str:
    """Archive tape id behind a case run (sealed windows point at their source)."""
    if run_id.startswith("sealed_"):
        meta = read_sealed_meta(run_id) or {}
        return meta.get("source_run_id") or meta.get("scenario") or run_id
    return run_id


def supports(run_id: str) -> bool:
    return source_tape(run_id) in RECIPES


def replay(
    tape: str,
    *,
    remove_fault: bool = False,
    extra: tuple[tuple[float, str], ...] = (),
    end_s: float | None = None,
) -> pd.DataFrame:
    return _replay_cached(tape, remove_fault, tuple(extra), end_s).copy()


@lru_cache(maxsize=64)
def _replay_cached(
    tape: str, remove_fault: bool, extra: tuple[tuple[float, str], ...], end_s: float | None
) -> pd.DataFrame:
    if tape not in RECIPES:
        raise KeyError(f"no replay recipe for tape {tape}")
    r = RECIPES[tape]
    spec = load_and_validate()
    end_clock = r["end"]
    if end_s is not None and end_s > clock_to_s(end_clock):
        end_clock = format_clock(end_s)
    faults = [] if remove_fault else None
    extra_cmds = list(extra)
    if r["kind"] == "heater":
        kw: dict[str, Any] = {}
        if "marginal" in r:
            kw["fault"] = marginal_heater_fault(spec, clock_to_s(r["enable"]), multiplier=r["marginal"])
            kw["initial_soc_pct"] = r["soc"]
        return run_heater_fault(
            spec, r["start"], end_clock, r["enable"], r["science"],
            faults=faults, extra_commands=extra_cmds, **kw,
        )
    if r["kind"] == "payload":
        return run_payload_fault(spec, r["start"], end_clock, r["science"], faults=faults, extra_commands=extra_cmds)
    return run_battery_fault(spec, r["start"], end_clock, r["enable"], faults=faults, extra_commands=extra_cmds)


def series(df: pd.DataFrame, channel: str, t0: float, t1: float) -> list[list[float]]:
    rows = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)]
    return [[float(t), round(float(v), 4)] for t, v in zip(rows["time_s"], rows[channel])]


def _healthy_side(value: float, limit: float, direction: str) -> bool:
    return value > limit if direction == "below" else value < limit


def outcome(
    df: pd.DataFrame, channel: str, t_from: float, limit: float, direction: str, settle_s: float = 60.0
) -> dict[str, Any]:
    """Did the channel get back to the healthy side of warn and stay there?"""
    after = df[df["time_s"] >= t_from]
    if after.empty:
        return {"clears": False}
    first = after.iloc[0]
    settled = after[after["time_s"] >= t_from + settle_s]
    vals = settled[channel] if not settled.empty else after[channel]
    clears = bool(all(_healthy_side(float(v), limit, direction) for v in vals))
    worst = float(vals.min() if direction == "below" else vals.max())
    recover_t = None
    for t, v in zip(after["time_s"], after[channel]):
        if _healthy_side(float(v), limit, direction):
            recover_t = float(t)
            break
    end = after.iloc[-1]
    ten = after[after["time_s"] >= t_from + 600.0]
    at_ten = ten.iloc[0] if not ten.empty else end
    return {
        "clears": clears,
        "first_value": round(float(first[channel]), 2),
        "first_clock": format_clock(float(first["time_s"])),
        "value_10min": round(float(at_ten[channel]), 2),
        "clock_10min": format_clock(float(at_ten["time_s"])),
        "worst": round(worst, 2),
        "recovered_in_s": round(recover_t - t_from, 1) if recover_t is not None and clears else None,
    }
