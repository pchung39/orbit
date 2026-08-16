"""Aurora-1 telemetry core.

Reads spec/aurora1_mission_model.yaml and steps discrete-time telemetry.
The spec is authoritative: if code and spec disagree, flag it — do not
silently change the code to paper over a mismatch.

This module is physics and spec loading only. Scenarios and CLI live in
scenarios.py and cli.py.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

SPEC_PATH = Path(__file__).resolve().parent.parent / "spec" / "aurora1_mission_model.yaml"

EXPECTED_CHANNELS = (
    "EPS.bus_voltage",
    "EPS.bus_current",
    "EPS.battery_voltage",
    "EPS.battery_current",
    "EPS.solar_array_current",
    "THM.battery_temperature",
    "THM.heater_b_temperature",
    "THM.heater_b_current",
    "PAY.power_draw",
    "PAY.payload_current",
    "PAY.mode",
)

REQUIRED_TOP_LEVEL = (
    "mission",
    "constants",
    "channels",
    "modes",
    "fault_library",
    "demo_scenario_EPS204",
)

REQUIRED_CHANNEL_FIELDS = ("subsystem", "unit", "sample_interval_s")

# Epoch is fictional; only durations and clock-of-day matter for the demo.
START_UTC = datetime(2026, 8, 14, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Assumptions NOT in the spec — flagged, not silent.
# ---------------------------------------------------------------------------
# SOC integrator: SOC += 100 * (I_batt * dt_s / 3600) / capacity_ah, clamp 0-100.
#   I_batt is the pre-noise value so sensor noise does not random-walk SOC.
# Battery voltage sign: spec writes OCV - I_batt * R with I_batt positive=charge.
#   That drops voltage while charging. We use V = OCV + I_charge * R instead.
# Bus IR drop 0.38 Ω is larger than "small": tuned so heater-fault alone stays
#   above EPS.bus_voltage warn (26.5 V) and SCIENCE_MODE pushes across — the
#   EPS-204 confounder story. Electricals are instantaneous, so the spec's
#   14:32:18 warn vs SCIENCE_MODE at 14:31:52 cannot both be exact; we match
#   "crosses at science-mode entry" and report the actual sample time.
# Thermal sample_interval_s is 10 s in the spec; we integrate and emit at 5 s
#   so the CSV is a rectangular frame. 10 s is treated as a downlink rate we
#   are not modeling yet.
# Thermostat: spec NOMINAL mode says heaters are thermostatically controlled
#   but gives no setpoints. Simple hysteresis on battery temperature.
# Charge regulation: spec identity I_batt = I_solar - I_bus overfills the
#   8 Ah pack in one orbit (array 5.2 A vs ~1.6 A loads). Excess is shunted
#   and charge current tapers from 95% → 100% SOC so multi-day runs float
#   instead of railing. I_solar is still the array output.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Assumptions:
    array_capacity_a: float = 5.2
    degradation_factor: float = 1.0
    heater_ref_v: float = 28.0
    payload_standby_a: float = 0.08
    payload_science_a: float = 0.90
    bus_ir_drop_ohm: float = 0.38
    battery_capacity_ah: float = 8.0
    initial_soc_pct: float = 90.0
    charge_taper_start_pct: float = 95.0
    ocv_empty_v: float = 26.0
    ocv_full_v: float = 29.2
    terminator_ramp_s: float = 120.0
    rng_seed: int = 42
    thermostat_on_c: float = 8.0
    thermostat_off_c: float = 14.0
    t_batt_init_c: float = 12.0
    t_heater_init_c: float = 14.0
    heater_temp_gain: float = 0.18
    battery_i2r_gain: float = 4.0
    heater_to_battery_couple: float = 0.025
    t_amb_batt_eclipse_c: float = 6.0
    t_amb_batt_sun_c: float = 18.0
    t_amb_heater_eclipse_c: float = 12.0
    t_amb_heater_sun_c: float = 18.0
    epoch: datetime = START_UTC


@dataclass(frozen=True)
class ActiveFault:
    """One injected fault. Nominal runs pass an empty list."""

    name: str
    onset_s: float
    channel: str
    multiplier: float


@dataclass
class SimState:
    t_s: float
    soc_pct: float
    t_batt_c: float
    t_heater_c: float
    heater_b_on: bool
    payload_mode: str
    force_heater: bool | None = None  # None = thermostat; True/False = commanded


def load_spec(path: Path = SPEC_PATH) -> dict[str, Any]:
    """Load the YAML mission model. Does not validate."""
    with path.open() as f:
        spec = yaml.safe_load(f)
    if not isinstance(spec, dict):
        raise ValueError(f"Spec at {path} is not a mapping")
    return spec


def validate_spec(spec: dict[str, Any]) -> list[str]:
    """Return a list of validation problems. Empty means the spec is usable."""
    problems: list[str] = []

    for key in REQUIRED_TOP_LEVEL:
        if key not in spec:
            problems.append(f"missing top-level key: {key}")

    channels = spec.get("channels")
    if not isinstance(channels, dict):
        problems.append("channels must be a mapping")
        return problems

    missing = [name for name in EXPECTED_CHANNELS if name not in channels]
    extra = [name for name in channels if name not in EXPECTED_CHANNELS]
    if missing:
        problems.append(f"missing channels: {missing}")
    if extra:
        problems.append(f"unexpected channels (spec/code mismatch): {extra}")

    for name, channel in channels.items():
        if not isinstance(channel, dict):
            problems.append(f"{name}: channel entry is not a mapping")
            continue
        for field in REQUIRED_CHANNEL_FIELDS:
            if field not in channel:
                problems.append(f"{name}: missing field {field}")

    faults = spec.get("fault_library", {})
    heater = faults.get("HEATER_B_OVERCURRENT")
    if not isinstance(heater, dict):
        problems.append("fault_library.HEATER_B_OVERCURRENT is missing")
    elif "fault_multiplier_on_heater_current" not in heater:
        problems.append("HEATER_B_OVERCURRENT missing fault_multiplier_on_heater_current")
    payload = faults.get("PAYLOAD_POWER_SPIKE")
    if not isinstance(payload, dict) or "fault_multiplier_on_payload_current" not in payload:
        problems.append("PAYLOAD_POWER_SPIKE missing fault_multiplier_on_payload_current")
    battery = faults.get("BATTERY_RESISTANCE_DEGRADATION")
    if not isinstance(battery, dict) or "fault_multiplier_on_internal_resistance" not in battery:
        problems.append("BATTERY_RESISTANCE_DEGRADATION missing fault_multiplier_on_internal_resistance")

    script = spec.get("demo_scenario_EPS204", {}).get("script")
    if not isinstance(script, list) or not script:
        problems.append("demo_scenario_EPS204.script is missing or empty")

    return problems


def load_and_validate(path: Path = SPEC_PATH) -> dict[str, Any]:
    spec = load_spec(path)
    problems = validate_spec(spec)
    if problems:
        raise ValueError("Spec validation failed:\n  - " + "\n  - ".join(problems))
    return spec


def heater_nominal_draw_a(spec: dict[str, Any], assumptions: Assumptions) -> float:
    r = spec["constants"]["heater_b_nominal_resistance_ohm"]
    return assumptions.heater_ref_v / r


def illumination_fraction(
    t_s: float, period_s: float, eclipse_fraction: float, ramp_s: float
) -> float:
    """0 in eclipse, 1 in sun, cosine ramp across the terminator."""
    phase_s = t_s % period_s
    eclipse_s = eclipse_fraction * period_s

    def ramp_01(remaining_s: float) -> float:
        x = 1.0 - remaining_s / ramp_s
        x = min(max(x, 0.0), 1.0)
        return 0.5 * (1.0 - math.cos(math.pi * x))

    if phase_s < eclipse_s:
        remaining = eclipse_s - phase_s
        return ramp_01(remaining) if remaining < ramp_s else 0.0
    remaining = period_s - phase_s
    return 1.0 - ramp_01(remaining) if remaining < ramp_s else 1.0


def open_circuit_voltage(soc_pct: float, assumptions: Assumptions) -> float:
    frac = min(max(soc_pct, 0.0), 100.0) / 100.0
    return assumptions.ocv_empty_v + (assumptions.ocv_full_v - assumptions.ocv_empty_v) * frac


def integrate_soc(soc_pct: float, i_batt_a: float, dt_s: float, capacity_ah: float) -> float:
    delta_ah = i_batt_a * dt_s / 3600.0
    next_soc = soc_pct + 100.0 * delta_ah / capacity_ah
    return min(max(next_soc, 0.0), 100.0)


def first_order_lag(current: float, target: float, dt_s: float, tau_s: float) -> float:
    if tau_s <= 0:
        return target
    return target + (current - target) * math.exp(-dt_s / tau_s)


def active_fault_multiplier(
    channel: str, t_s: float, faults: list[ActiveFault]
) -> float:
    """Shared lookup: default 1.0. Fault #2 will use this same function."""
    multiplier = 1.0
    for fault in faults:
        if t_s >= fault.onset_s and fault.channel == channel:
            multiplier *= fault.multiplier
    return multiplier


def payload_current_a(mode: str, multiplier: float, assumptions: Assumptions) -> float:
    if mode == "SCIENCE_MODE":
        baseline = assumptions.payload_science_a
    else:
        baseline = assumptions.payload_standby_a
    return baseline * multiplier


def heater_current_a(heater_on: bool, multiplier: float, nominal_a: float) -> float:
    return 0.0 if not heater_on else nominal_a * multiplier


def solar_array_current_a(illum: float, assumptions: Assumptions) -> float:
    return assumptions.array_capacity_a * illum * assumptions.degradation_factor


def regulated_battery_current(i_solar: float, i_bus: float, soc_pct: float, taper_start_pct: float) -> float:
    """I_batt = I_solar - I_bus, then taper charge as the pack nears full."""
    i_batt = i_solar - i_bus
    if i_batt <= 0.0:
        return i_batt
    headroom = max(0.0, 100.0 - soc_pct)
    span = max(100.0 - taper_start_pct, 1e-6)
    return i_batt * min(1.0, headroom / span)


def bus_current_a(payload_a: float, heater_a: float, spec: dict[str, Any]) -> float:
    c = spec["constants"]
    return (
        c["baseline_avionics_load_a"]
        + c["baseline_comms_load_a"]
        + payload_a
        + heater_a
    )


def battery_voltage_v(soc_pct: float, i_batt_a: float, r_int: float, assumptions: Assumptions) -> float:
    # Physical sign. Spec formula is the opposite; flagged above.
    return open_circuit_voltage(soc_pct, assumptions) + i_batt_a * r_int


def bus_voltage_v(v_batt: float, i_bus: float, assumptions: Assumptions) -> float:
    return v_batt - assumptions.bus_ir_drop_ohm * i_bus


def apply_thermostat(state: SimState, assumptions: Assumptions) -> bool:
    if state.force_heater is not None:
        return state.force_heater
    if state.t_batt_c <= assumptions.thermostat_on_c:
        return True
    if state.t_batt_c >= assumptions.thermostat_off_c:
        return False
    return state.heater_b_on


def mix(lo: float, hi: float, frac: float) -> float:
    return lo + (hi - lo) * frac


def apply_action(state: SimState, action: str) -> None:
    if action == "HEATER_B_ENABLE":
        state.force_heater = True
    elif action == "SCIENCE_MODE":
        state.payload_mode = "SCIENCE_MODE"
    else:
        raise ValueError(f"unknown command action: {action}")


def _noise(rng: np.random.Generator, value: float, stddev: float | None) -> float:
    if not stddev:
        return value
    return float(value + rng.normal(0.0, stddev))


def _stddev(spec: dict[str, Any], channel: str) -> float:
    return float(spec["channels"][channel].get("noise_stddev") or 0.0)


def step(
    state: SimState,
    spec: dict[str, Any],
    assumptions: Assumptions,
    rng: np.random.Generator,
    faults: list[ActiveFault],
    dt_s: float,
) -> tuple[SimState, dict[str, Any]]:
    """Advance one tick. Electricals are algebraic; SOC and temps integrate."""
    c = spec["constants"]
    illum = illumination_fraction(
        state.t_s,
        c["orbital_period_min"] * 60.0,
        c["eclipse_fraction"],
        assumptions.terminator_ramp_s,
    )
    heater_on = apply_thermostat(state, assumptions)

    i_heater = heater_current_a(
        heater_on,
        active_fault_multiplier("THM.heater_b_current", state.t_s, faults),
        heater_nominal_draw_a(spec, assumptions),
    )
    i_payload = payload_current_a(
        state.payload_mode,
        active_fault_multiplier("PAY.payload_current", state.t_s, faults),
        assumptions,
    )
    i_solar = solar_array_current_a(illum, assumptions)
    i_bus = bus_current_a(i_payload, i_heater, spec)
    i_batt = regulated_battery_current(
        i_solar, i_bus, state.soc_pct, assumptions.charge_taper_start_pct
    )
    r_batt = c["battery_internal_resistance_ohm_nominal"] * active_fault_multiplier(
        "battery_internal_resistance", state.t_s, faults
    )
    v_batt = battery_voltage_v(state.soc_pct, i_batt, r_batt, assumptions)
    v_bus = bus_voltage_v(v_batt, i_bus, assumptions)
    p_payload = i_payload * v_bus

    heater_heat = (i_heater**2) * c["heater_b_nominal_resistance_ohm"]
    batt_heat = (i_batt**2) * r_batt
    t_eq_heater = mix(
        assumptions.t_amb_heater_eclipse_c, assumptions.t_amb_heater_sun_c, illum
    ) + assumptions.heater_temp_gain * heater_heat
    t_eq_batt = (
        mix(assumptions.t_amb_batt_eclipse_c, assumptions.t_amb_batt_sun_c, illum)
        + assumptions.battery_i2r_gain * batt_heat
        + assumptions.heater_to_battery_couple * heater_heat
    )
    t_heater = first_order_lag(state.t_heater_c, t_eq_heater, dt_s, 300.0)
    t_batt = first_order_lag(state.t_batt_c, t_eq_batt, dt_s, 600.0)
    soc = integrate_soc(state.soc_pct, i_batt, dt_s, assumptions.battery_capacity_ah)

    sample = {
        "time_s": state.t_s,
        "timestamp": assumptions.epoch + timedelta(seconds=state.t_s),
        "EPS.bus_voltage": _noise(rng, v_bus, _stddev(spec, "EPS.bus_voltage")),
        "EPS.bus_current": _noise(rng, i_bus, _stddev(spec, "EPS.bus_current")),
        "EPS.battery_voltage": _noise(rng, v_batt, _stddev(spec, "EPS.battery_voltage")),
        "EPS.battery_current": _noise(rng, i_batt, _stddev(spec, "EPS.battery_current")),
        "EPS.solar_array_current": max(
            0.0, _noise(rng, i_solar, _stddev(spec, "EPS.solar_array_current"))
        ),
        "THM.battery_temperature": _noise(rng, t_batt, _stddev(spec, "THM.battery_temperature")),
        "THM.heater_b_temperature": _noise(rng, t_heater, _stddev(spec, "THM.heater_b_temperature")),
        "THM.heater_b_current": max(
            0.0, _noise(rng, i_heater, _stddev(spec, "THM.heater_b_current"))
        ),
        "PAY.power_draw": max(0.0, _noise(rng, p_payload, _stddev(spec, "PAY.power_draw"))),
        "PAY.payload_current": max(
            0.0, _noise(rng, i_payload, _stddev(spec, "PAY.payload_current"))
        ),
        "PAY.mode": state.payload_mode,
        "soc_pct": soc,  # internal state, not a spec channel
    }

    next_state = SimState(
        t_s=state.t_s + dt_s,
        soc_pct=soc,
        t_batt_c=t_batt,
        t_heater_c=t_heater,
        heater_b_on=heater_on,
        payload_mode=state.payload_mode,
        force_heater=state.force_heater,
    )
    return next_state, sample


def initial_state(assumptions: Assumptions, t_s: float = 0.0) -> SimState:
    return SimState(
        t_s=t_s,
        soc_pct=assumptions.initial_soc_pct,
        t_batt_c=assumptions.t_batt_init_c,
        t_heater_c=assumptions.t_heater_init_c,
        heater_b_on=False,
        payload_mode="STANDBY",
        force_heater=None,
    )


def run_simulation(
    spec: dict[str, Any],
    duration_s: float,
    assumptions: Assumptions | None = None,
    faults: list[ActiveFault] | None = None,
    state: SimState | None = None,
    commands: list[tuple[float, str]] | None = None,
) -> pd.DataFrame:
    assumptions = assumptions or Assumptions()
    faults = faults or []
    commands = commands or []
    state = state or initial_state(assumptions)
    dt_s = float(spec["constants"]["default_sample_interval_s"])
    rng = np.random.default_rng(assumptions.rng_seed)

    rows: list[dict[str, Any]] = []
    n_steps = int(duration_s / dt_s)
    for _ in range(n_steps):
        for t_cmd, action in commands:
            if state.t_s >= t_cmd:
                apply_action(state, action)
        state, sample = step(state, spec, assumptions, rng, faults, dt_s)
        rows.append(sample)
    return pd.DataFrame(rows)


def summarize(df: pd.DataFrame, spec: dict[str, Any]) -> str:
    lines = [
        f"samples: {len(df)}",
        f"duration_h: {(df['time_s'].iloc[-1] - df['time_s'].iloc[0]) / 3600:.2f}",
        f"soc_pct: {df['soc_pct'].min():.1f} .. {df['soc_pct'].max():.1f}",
    ]
    for name, channel in spec["channels"].items():
        if name == "PAY.mode":
            lines.append(f"{name}: {sorted(df[name].unique())}")
            continue
        lo, hi = df[name].min(), df[name].max()
        nominal = channel.get("nominal_range")
        extra = f"  nominal={nominal}" if nominal else ""
        lines.append(f"{name}: {lo:.3f} .. {hi:.3f}{extra}")
    return "\n".join(lines)


if __name__ == "__main__":
    from simulator.cli import main

    main()
