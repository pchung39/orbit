"""Dummy mission: four weeks of Aurora-1 history with hidden truth.

ORBIT's model has to learn the spacecraft from this history, so the generator
keeps its true parameters in a separate truth file that ORBIT itself never
reads. Tests (and an explicitly labelled dummy-data check in the UI) compare
what ORBIT learned against it.

The history is deliberately messy, like a small mission's real archive:
routine operator commands, two load faults and one more in the final week,
slow battery wear, telemetry gaps, single-sample glitches, and a few commands
ORBIT has no mapping for.

python -m simulator.mission            # writes runs/mission/
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from simulator.simulate import ActiveFault, Assumptions, SimState, load_and_validate, step

ROOT = Path(__file__).resolve().parent.parent
MISSION_DIR = ROOT / "runs" / "mission"
TELEMETRY_CSV = MISSION_DIR / "telemetry.csv"
COMMANDS_CSV = MISSION_DIR / "commands.csv"
TRUTH_JSON = MISSION_DIR / "truth.json"
MANIFEST_JSON = MISSION_DIR / "manifest.json"

EPOCH = datetime(2026, 7, 17, tzinfo=timezone.utc)  # history ends where the demo cases begin
DAYS = 28
DT_S = 10.0
SEED = 7

# Commands ORBIT knows how to interpret. Anything else in the log is "unmapped".
MAPPED = ("HEATER_B_ENABLE", "HEATER_B_DISABLE", "SCIENCE_MODE", "PAYLOAD_STANDBY")
UNMAPPED = ("PL_RST", "ADCS_MODE_FINE", "XPDR_HIGH_RATE")


@dataclass(frozen=True)
class Truth:
    """What the spacecraft really is. Hidden from ORBIT's model."""

    bus_harness_ohm: float
    battery_ohm_start: float
    battery_ohm_end: float
    heater_healthy_a: float
    payload_science_a: float
    payload_standby_a: float
    baseline_load_a: float


@dataclass(frozen=True)
class Episode:
    kind: str  # heater_overcurrent | payload_spike
    start_s: float
    end_s: float
    multiplier: float


def _truth(spec: dict[str, Any], a: Assumptions) -> Truth:
    c = spec["constants"]
    r_batt = c["battery_internal_resistance_ohm_nominal"]
    return Truth(
        bus_harness_ohm=a.bus_ir_drop_ohm,
        battery_ohm_start=round(r_batt * 0.85, 4),  # ages to the nominal 0.08 Ω by the end of the record
        battery_ohm_end=r_batt,
        heater_healthy_a=round(a.heater_ref_v / c["heater_b_nominal_resistance_ohm"], 4),
        payload_science_a=a.payload_science_a,
        payload_standby_a=a.payload_standby_a,
        baseline_load_a=c["baseline_avionics_load_a"] + c["baseline_comms_load_a"],
    )


def _schedule(spec: dict[str, Any], rng: np.random.Generator) -> tuple[list[tuple[float, str, str]], list[Episode]]:
    """Operator plan: heater on through most eclipses, science passes in sunlight, three faults."""
    period = spec["constants"]["orbital_period_min"] * 60.0
    eclipse = spec["constants"]["eclipse_fraction"] * period
    end = DAYS * 86400.0
    cmds: list[tuple[float, str, str]] = []
    episodes: list[Episode] = []
    n_orbits = int(end // period)

    # Fault plan: (orbit index, kind, multiplier, minutes until ops respond)
    faults = {
        int(n_orbits * 0.32): ("heater_overcurrent", 3.2, 7),
        int(n_orbits * 0.57): ("payload_spike", 3.0, 5),
        int(n_orbits * 0.86): ("heater_overcurrent", 3.2, 6),
    }
    for k in range(n_orbits):
        t0 = k * period
        fault = faults.get(k)
        if fault and fault[0] == "heater_overcurrent":
            on = t0 + 4 * 60 + rng.uniform(0, 120)
            off = on + fault[2] * 60
            cmds += [(on, "HEATER_B_ENABLE", "ops"), (off, "HEATER_B_DISABLE", "ops")]
            episodes.append(Episode("heater_overcurrent", on, off, fault[1]))
        elif rng.random() < 0.55:
            on = t0 + 3 * 60 + rng.uniform(0, 180)
            off = t0 + eclipse - rng.uniform(60, 240)
            cmds += [(on, "HEATER_B_ENABLE", "ops"), (off, "HEATER_B_DISABLE", "ops")]
        if fault and fault[0] == "payload_spike":
            sci = t0 + eclipse + 10 * 60 + rng.uniform(0, 300)
            stb = sci + fault[2] * 60
            cmds += [(sci, "SCIENCE_MODE", "ops"), (stb, "PAYLOAD_STANDBY", "ops")]
            episodes.append(Episode("payload_spike", sci, stb, fault[1]))
        elif rng.random() < 0.4:
            sci = t0 + eclipse + 6 * 60 + rng.uniform(0, 20 * 60)
            stb = sci + rng.uniform(10, 22) * 60
            cmds += [(sci, "SCIENCE_MODE", "ops"), (stb, "PAYLOAD_STANDBY", "ops")]
        if rng.random() < 0.06:
            cmds.append((t0 + rng.uniform(0, period), str(rng.choice(UNMAPPED)), "ops"))
    cmds = [(round(t), name, src) for t, name, src in cmds if t < end - 120]
    cmds.sort(key=lambda c: c[0])
    return cmds, episodes


def generate(out_dir: Path = MISSION_DIR) -> dict[str, Any]:
    spec = load_and_validate()
    rng = np.random.default_rng(SEED)
    a = Assumptions(initial_soc_pct=92.0, t_batt_init_c=14.0, t_heater_init_c=14.0, epoch=EPOCH, rng_seed=SEED)
    truth = _truth(spec, a)
    cmds, episodes = _schedule(spec, rng)

    state = SimState(t_s=0.0, soc_pct=a.initial_soc_pct, t_batt_c=a.t_batt_init_c, t_heater_c=a.t_heater_init_c,
                     heater_b_on=False, payload_mode="STANDBY", force_heater=False)
    noise = np.random.default_rng(SEED + 1)
    end = DAYS * 86400.0
    r_nominal = spec["constants"]["battery_internal_resistance_ohm_nominal"]
    rows: list[dict[str, Any]] = []
    ci = 0
    while state.t_s < end:
        while ci < len(cmds) and cmds[ci][0] <= state.t_s:
            action = cmds[ci][1]
            if action == "HEATER_B_ENABLE":
                state.force_heater = True
            elif action == "HEATER_B_DISABLE":
                state.force_heater = False
            elif action == "SCIENCE_MODE":
                state.payload_mode = "SCIENCE_MODE"
            elif action == "PAYLOAD_STANDBY":
                state.payload_mode = "STANDBY"
            ci += 1
        frac = state.t_s / end
        r_now = truth.battery_ohm_start + (truth.battery_ohm_end - truth.battery_ohm_start) * frac
        faults = [ActiveFault("battery_wear", 0.0, "battery_internal_resistance", r_now / r_nominal)]
        for ep in episodes:
            if ep.start_s <= state.t_s < ep.end_s:
                channel = "THM.heater_b_current" if ep.kind == "heater_overcurrent" else "PAY.payload_current"
                faults.append(ActiveFault(ep.kind, ep.start_s, channel, ep.multiplier))
        state, sample = step(state, spec, a, noise, faults, DT_S)
        rows.append(sample)

    df = pd.DataFrame(rows)
    df["timestamp"] = df["timestamp"].map(lambda t: t.isoformat())
    df = df.drop(columns=["soc_pct"])

    # Messiness: single-sample glitches, then downlink gaps (rows simply missing).
    glitch_idx = rng.choice(len(df), size=8, replace=False)
    df.loc[glitch_idx, "EPS.bus_voltage"] = df.loc[glitch_idx, "EPS.bus_voltage"] - rng.uniform(1.5, 3.0, size=8)
    gaps = []
    for _ in range(14):
        start = float(rng.uniform(3600, end - 3600))
        length = float(rng.uniform(3, 45) * 60)
        gaps.append((start, start + length))
    keep = np.ones(len(df), dtype=bool)
    for g0, g1 in gaps:
        keep &= ~((df["time_s"] >= g0) & (df["time_s"] < g1)).to_numpy()
    df = df[keep].reset_index(drop=True)

    out_dir.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_dir / TELEMETRY_CSV.name, index=False, float_format="%.4f")
    cdf = pd.DataFrame(cmds, columns=["time_s", "command", "source"])
    cdf["timestamp"] = cdf["time_s"].map(lambda t: (EPOCH + timedelta(seconds=float(t))).isoformat())
    cdf[["time_s", "timestamp", "command", "source"]].to_csv(out_dir / COMMANDS_CSV.name, index=False)

    (out_dir / TRUTH_JSON.name).write_text(json.dumps({
        "note": "Hidden truth for the dummy mission. ORBIT's model never reads this file.",
        **asdict(truth),
        "episodes": [asdict(e) for e in episodes],
    }, indent=2))
    manifest = {
        "name": "Aurora-1 · dummy mission history",
        "synthetic": True,
        "start": EPOCH.isoformat(),
        "end": (EPOCH + timedelta(days=DAYS)).isoformat(),
        "days": DAYS,
        "sample_interval_s": DT_S,
        "rows": int(len(df)),
        "channels": [c for c in df.columns if c not in ("time_s", "timestamp")],
        "commands": int(len(cdf)),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (out_dir / MANIFEST_JSON.name).write_text(json.dumps(manifest, indent=2))
    return manifest


def ensure_mission() -> None:
    if not (TELEMETRY_CSV.exists() and COMMANDS_CSV.exists() and MANIFEST_JSON.exists()):
        generate()


def main() -> None:
    m = generate()
    print(f"wrote {MISSION_DIR}: {m['rows']} samples over {m['days']} days, {m['commands']} commands")


if __name__ == "__main__":
    main()
