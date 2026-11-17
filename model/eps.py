"""ORBIT's power model: physics shape, numbers learned from the spacecraft's history.

Hybrid model of the electrical power system:

    battery V = open-circuit V + r_batt · I_batt          (I_batt > 0 charging)
    bus V     = battery V − r_bus · I_bus
    open-circuit V moves with charge: v_per_ah · ∫ I_batt dt

The shape is fixed physics; r_bus, r_batt, v_per_ah and the healthy load draws
are learned from history at command steps (a heater switching on is a clean
experiment: ΔV/ΔI). Predictions use the currents ORBIT actually observes, so a
faulted heater's real draw is respected without the model "knowing" the fault.

Three jobs:
  calibrate()   learn the numbers from the first 70% of history, keep the rest unseen
  backtest      predict every unseen command's effect, score it against what happened
  fit_check()   before any preview, replay what already happened in this case window
"""

from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from simulator.simulate import load_and_validate

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "runs" / "models"
MODEL_JSON = MODEL_DIR / "eps.json"

BUS_V, BUS_I = "EPS.bus_voltage", "EPS.bus_current"
BATT_V, BATT_I = "EPS.battery_voltage", "EPS.battery_current"
SOLAR, HEATER, PAYLOAD, MODE = "EPS.solar_array_current", "THM.heater_b_current", "PAY.payload_current", "PAY.mode"

TRAIN_FRACTION = 0.7
BACKTEST_TOL_V = 0.15        # a prediction within this of what happened counts as right
STEP_BEFORE = (-60.0, -2.0)  # seconds around a command used to measure a step
STEP_AFTER = (3.0, 60.0)
PREVIEW_HORIZON_S = 15 * 60.0
STEP_SPAN_S = ((STEP_AFTER[0] + STEP_AFTER[1]) - (STEP_BEFORE[0] + STEP_BEFORE[1])) / 2.0  # ~62 s between medians

PARAM_LABELS = {
    "bus_harness_ohm": ("Bus wiring resistance", "Ω"),
    "battery_ohm": ("Battery internal resistance", "Ω"),
    "battery_v_per_ah": ("Battery voltage per amp-hour", "V/Ah"),
    "heater_healthy_a": ("Heater B healthy draw", "A"),
    "payload_science_a": ("Payload draw in science mode", "A"),
    "payload_standby_a": ("Payload draw in standby", "A"),
    "baseline_load_a": ("Avionics + radio baseline", "A"),
}


# ── Model parameters ─────────────────────────────────────────────────────────

@dataclass
class EpsModel:
    params: dict[str, float]
    status: str  # "calibrated" | "datasheet"
    calibrated_at: str | None = None
    backtest: dict[str, Any] = field(default_factory=dict)

    @property
    def stamp(self) -> str:
        return self.calibrated_at or "datasheet"

    def tolerance(self, channel: str) -> float:
        """Typical prediction error, from the backtest when there is one."""
        bt = (self.backtest.get("channels") or {}).get(channel)
        if bt and bt.get("mae") is not None:
            return max(0.04, float(bt["mae"]))
        return 0.15 if self.status == "datasheet" else 0.08


def datasheet() -> EpsModel:
    spec = load_and_validate()
    return EpsModel(params=dict(spec["model_prior"]), status="datasheet")


def load_model() -> EpsModel:
    if MODEL_JSON.exists():
        data = json.loads(MODEL_JSON.read_text())
        return EpsModel(params=data["params"], status="calibrated",
                        calibrated_at=data.get("calibrated_at"), backtest=data.get("backtest") or {})
    return datasheet()


def model_report() -> dict[str, Any] | None:
    return json.loads(MODEL_JSON.read_text()) if MODEL_JSON.exists() else None


# ── Physics helpers ──────────────────────────────────────────────────────────

def battery_share(i_batt: float, i_solar: float, i_bus: float) -> float:
    """How much of a bus-load change the battery absorbs (0–1).

    Discharging: every extra amp comes from the battery (1). Charging near full,
    the charger tapers, so a load change moves battery current only partly.
    """
    if i_batt <= 0.05:
        return 1.0
    surplus = i_solar - i_bus
    if surplus <= 0.2:
        return 1.0
    return float(min(1.0, max(0.0, i_batt / surplus)))


def _median(df: pd.DataFrame, col: str, t0: float, t1: float) -> float | None:
    rows = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)][col].dropna()
    return float(rows.median()) if len(rows) >= 3 else None


def _step(df: pd.DataFrame, t: float) -> dict[str, float] | None:
    """Median of each channel just before and just after time t."""
    out: dict[str, float] = {}
    for col in (BUS_V, BUS_I, BATT_V, BATT_I, SOLAR, HEATER, PAYLOAD):
        b = _median(df, col, t + STEP_BEFORE[0], t + STEP_BEFORE[1])
        a = _median(df, col, t + STEP_AFTER[0], t + STEP_AFTER[1])
        if a is None or b is None:
            return None
        out[col + ":before"], out[col + ":after"] = b, a
        out[col + ":delta"] = a - b
    return out


# ── Calibration + backtest ───────────────────────────────────────────────────

def _load_history() -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """History from whichever source is connected (dummy CSV, uploaded CSV, or a database)."""
    from storage.connectors import load_history

    return load_history()


def calibrate(save: bool = True) -> dict[str, Any]:
    tel, cmds, manifest = _load_history()
    prior = datasheet().params
    t_end = float(tel["time_s"].max())
    split = float(tel["time_s"].min()) + TRAIN_FRACTION * (t_end - float(tel["time_s"].min()))
    train = tel[tel["time_s"] < split]

    mapped = cmds[cmds["command"].isin(["HEATER_B_ENABLE", "HEATER_B_DISABLE", "SCIENCE_MODE", "PAYLOAD_STANDBY"])]
    steps: list[dict[str, Any]] = []
    for _, c in mapped.iterrows():
        st = _step(tel, float(c["time_s"]))
        if st is None:
            continue
        st["t"], st["command"] = float(c["time_s"]), c["command"]
        steps.append(st)
    usable = [s for s in steps if abs(s[BUS_I + ":delta"]) > 0.3 and abs(s[SOLAR + ":delta"]) < 0.15]
    train_steps = [s for s in usable if s["t"] < split]

    # Resistances from clean step experiments: battery sees ΔI_batt, bus adds harness drop.
    # Two passes: the battery drains a little during each ~1-minute step, so once the
    # charge term is known, remove that drift before reading the resistance.
    def r_batt_of(s: dict[str, Any], v_per_ah: float) -> float:
        return (s[BATT_V + ":delta"] - _step_drift(s, v_per_ah)) / s[BATT_I + ":delta"]

    batt_steps = [s for s in train_steps if abs(s[BATT_I + ":delta"]) > 0.3]
    r_rough = statistics.median([r_batt_of(s, 0.0) for s in batt_steps])
    v_per_ah = _fit_v_per_ah(train, cmds, r_rough)
    r_batt_est = [r_batt_of(s, v_per_ah) for s in batt_steps]
    r_bus_est = [-(s[BUS_V + ":delta"] - s[BATT_V + ":delta"]) / s[BUS_I + ":delta"] for s in train_steps]
    recent = [s for s in batt_steps if s["t"] > split - 7 * 86400]
    r_batt_recent = [r_batt_of(s, v_per_ah) for s in recent]

    # Battery wear: resistance per week across the whole record.
    weeks = []
    t0 = float(tel["time_s"].min())
    for w in range(int((t_end - t0) // (7 * 86400)) + 1):
        ws = [r_batt_of(s, v_per_ah) for s in usable
              if t0 + w * 7 * 86400 <= s["t"] < t0 + (w + 1) * 7 * 86400 and abs(s[BATT_I + ":delta"]) > 0.3]
        if len(ws) >= 3:
            weeks.append({"week": w + 1, "battery_ohm": round(statistics.median(ws), 4), "n": len(ws)})

    heater_on = train[train[HEATER] > 0.3][HEATER]
    h_med = float(heater_on.median())
    heater_healthy = float(heater_on[heater_on < 1.5 * h_med].median())
    sci = train[(train[MODE] == "SCIENCE_MODE")][PAYLOAD]
    sci_med = float(sci.median())
    science = float(sci[sci < 1.5 * sci_med].median())
    standby = float(train[train[MODE] == "STANDBY"][PAYLOAD].median())
    baseline = float((train[BUS_I] - train[HEATER] - train[PAYLOAD]).median())

    params = {
        "bus_harness_ohm": round(statistics.median(r_bus_est), 4),
        "battery_ohm": round(statistics.median(r_batt_recent or r_batt_est), 4),
        "battery_v_per_ah": round(v_per_ah, 4),
        "heater_healthy_a": round(heater_healthy, 3),
        "payload_science_a": round(science, 3),
        "payload_standby_a": round(standby, 3),
        "baseline_load_a": round(baseline, 3),
    }
    model = EpsModel(params=params, status="calibrated")
    backtest = _backtest(model, [s for s in steps if s["t"] >= split])

    report = {
        "calibrated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": manifest["name"],
        "source_kind": manifest.get("kind"),
        "source_stamp": manifest.get("stamp"),
        "synthetic": manifest.get("synthetic", False),
        "history": {"start": manifest["start"], "end": manifest["end"], "days": manifest["days"],
                    "rows": manifest["rows"]},
        "split": {"learned_from_days": round((split - t0) / 86400, 1),
                  "tested_on_days": round((t_end - split) / 86400, 1)},
        "steps_used": len(train_steps),
        "params": params,
        "prior": prior,
        "wear": weeks,
        "backtest": backtest,
        "truth_check": _truth_check(params, weeks) if manifest.get("synthetic") else None,
    }
    if save:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        MODEL_JSON.write_text(json.dumps(report, indent=2))
    return report


def _fit_v_per_ah(train: pd.DataFrame, cmds: pd.DataFrame, r_batt: float) -> float:
    """Open-circuit voltage slope: Δ(V_batt − r·I_batt) / ΔAh over 10-minute quiet discharge windows."""
    df = train[[ "time_s", BATT_V, BATT_I]].dropna().reset_index(drop=True)
    cmd_t = np.sort(cmds["time_s"].to_numpy())
    times = df["time_s"].to_numpy()
    ocv = (df[BATT_V] - r_batt * df[BATT_I]).to_numpy()
    cur = df[BATT_I].to_numpy()
    out = []
    i = 0
    while i < len(df) - 61:
        j = i + 60  # ~10 minutes at 10 s
        if times[j] - times[i] > 610 or (cur[i:j] > -0.5).any():
            i += 30
            continue
        lo, hi = np.searchsorted(cmd_t, times[i]), np.searchsorted(cmd_t, times[j])
        if hi > lo:
            i += 30
            continue
        ah = float(np.trapezoid(cur[i:j + 1], times[i:j + 1]) / 3600.0)
        if abs(ah) > 0.3:
            out.append((ocv[j] - ocv[i]) / ah)
        i += 60
    return float(statistics.median(out)) if out else 0.35


def _step_drift(s: dict[str, Any], v_per_ah: float) -> float:
    """Open-circuit voltage change between the before and after medians from charge moved."""
    i_avg = (s[BATT_I + ":before"] + s[BATT_I + ":after"]) / 2.0
    return v_per_ah * i_avg * STEP_SPAN_S / 3600.0


def expected_load_change(model: EpsModel, command: str, before: dict[str, float]) -> float:
    """What the model expects a command to do to bus current, from the state just before it."""
    p = model.params
    if command == "HEATER_B_ENABLE":
        return p["heater_healthy_a"]
    if command == "HEATER_B_DISABLE":
        return -before[HEATER]
    if command == "SCIENCE_MODE":
        return p["payload_science_a"] - before[PAYLOAD]
    if command == "PAYLOAD_STANDBY":
        return -(before[PAYLOAD] - p["payload_standby_a"])
    return 0.0


def predict_step(model: EpsModel, before: dict[str, float], d_bus_i: float, span_s: float = 0.0) -> dict[str, float]:
    """Voltage change from a load change; span_s adds the charge drift over that many seconds."""
    p = model.params
    k = battery_share(before[BATT_I], before[SOLAR], before[BUS_I])
    d_batt_i = -k * d_bus_i
    drift = p["battery_v_per_ah"] * (before[BATT_I] + d_batt_i / 2.0) * span_s / 3600.0
    d_batt_v = p["battery_ohm"] * d_batt_i + drift
    return {BATT_V: d_batt_v, BUS_V: d_batt_v - p["bus_harness_ohm"] * d_bus_i, BUS_I: d_bus_i}


def _backtest(model: EpsModel, steps: list[dict[str, Any]]) -> dict[str, Any]:
    rows = []
    for s in steps:
        before = {c: s[c + ":before"] for c in (BUS_V, BUS_I, BATT_V, BATT_I, SOLAR, HEATER, PAYLOAD)}
        d_i = expected_load_change(model, s["command"], before)
        pred = predict_step(model, before, d_i, STEP_SPAN_S)
        actual_di = s[BUS_I + ":delta"]
        row = {"t": s["t"], "command": s["command"], "solar_delta": round(s[SOLAR + ":delta"], 2)}
        for ch in (BUS_V, BATT_V):
            row[ch] = {"pred": round(pred[ch], 3), "actual": round(s[ch + ":delta"], 3),
                       "err": round(pred[ch] - s[ch + ":delta"], 3)}
        row["expected_di"], row["actual_di"] = round(d_i, 3), round(actual_di, 3)
        rows.append(row)

    channels = {}
    for ch, label in ((BUS_V, "Bus voltage"), (BATT_V, "Battery voltage")):
        errs = [abs(r[ch]["err"]) for r in rows]
        hits = sum(e <= BACKTEST_TOL_V for e in errs)
        channels[ch] = {"label": label, "hits": hits, "total": len(errs),
                        "mae": round(statistics.mean(errs), 3) if errs else None}

    misses = []
    for r in rows:
        if abs(r[BUS_V]["err"]) <= BACKTEST_TOL_V:
            continue
        ratio = r["actual_di"] / r["expected_di"] if abs(r["expected_di"]) > 0.05 else None
        if ratio is not None and ratio > 1.6 and r["command"] in ("HEATER_B_ENABLE", "SCIENCE_MODE"):
            load = "Heater B" if r["command"] == "HEATER_B_ENABLE" else "The payload"
            why = f"{load} drew {ratio:.1f}× its learned healthy amount: a fault the model can't foresee."
            kind = "fault"
        elif abs(r["solar_delta"]) > 0.5:
            why = f"Sunrise during the step: solar current rose {r['solar_delta']:.1f} A. The model doesn't forecast orbit lighting yet."
            kind = "sunrise"
        else:
            why = "The load changed as expected, but the voltage didn't follow. Possibly the charger tapering near full."
            kind = "other"
        r = {**r, "kind": kind}
        misses.append({**r, "why": why})
    kinds: dict[str, int] = {}
    for m in misses:
        kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
    return {
        "miss_kinds": kinds,
        "tolerance_v": BACKTEST_TOL_V,
        "channels": channels,
        "not_modeled": ["THM.heater_b_temperature", "THM.battery_temperature"],
        "misses": misses[:20],
        "n": len(rows),
    }


def _truth_check(params: dict[str, float], weeks: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Dummy data only: compare what was learned with the generator's hidden truth."""
    from simulator import mission

    if not mission.TRUTH_JSON.exists():
        return None
    truth = json.loads(mission.TRUTH_JSON.read_text())
    pairs = [
        ("bus_harness_ohm", truth["bus_harness_ohm"]),
        ("battery_ohm", truth["battery_ohm_end"]),
        ("heater_healthy_a", truth["heater_healthy_a"]),
        ("payload_science_a", truth["payload_science_a"]),
        ("payload_standby_a", truth["payload_standby_a"]),
        ("baseline_load_a", truth["baseline_load_a"]),
    ]
    out = []
    for key, true_v in pairs:
        learned = params[key]
        rel = abs(learned - true_v) / true_v if true_v else 0.0
        out.append({"param": key, "label": PARAM_LABELS[key][0], "unit": PARAM_LABELS[key][1],
                    "learned": learned, "truth": round(true_v, 4), "error_pct": round(rel * 100, 1),
                    "ok": rel <= 0.08})
    return out


# ── Case-time use: fit check, previews, what-ifs ─────────────────────────────

def _series(df: pd.DataFrame, col: str, t0: float, t1: float) -> pd.DataFrame:
    return df[(df["time_s"] >= t0) & (df["time_s"] <= t1)][["time_s", col]].dropna()


def replay_window(model: EpsModel, df: pd.DataFrame, channel: str, t0: float, t1: float) -> pd.DataFrame:
    """Rebuild a voltage channel from the observed currents, starting from the first minute's level."""
    p = model.params
    w = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)][["time_s", BUS_V, BUS_I, BATT_V, BATT_I]].dropna()
    ref = w[w["time_s"] <= t0 + 60]
    v_ref = float(ref[channel].median())
    ib_ref, ia_ref = float(ref[BATT_I].median()), float(ref[BUS_I].median())
    ah = np.concatenate([[0.0], np.cumsum(np.diff(w["time_s"].to_numpy()) * w[BATT_I].to_numpy()[1:]) / 3600.0])
    pred = v_ref + p["battery_ohm"] * (w[BATT_I] - ib_ref) + p["battery_v_per_ah"] * ah
    if channel == BUS_V:
        pred = pred - p["bus_harness_ohm"] * (w[BUS_I] - ia_ref)
    return pd.DataFrame({"time_s": w["time_s"], "observed": w[channel], "model": pred})


def fit_check(model: EpsModel, df: pd.DataFrame, channel: str, t0: float, t_dec: float) -> dict[str, Any]:
    """Does the model reproduce what already happened in this case, before we trust its forecast?"""
    ch = channel if channel in (BUS_V, BATT_V) else BUS_V
    r = replay_window(model, df, ch, t0, t_dec)
    resid = (r["observed"] - r["model"]).to_numpy()
    rms = float(np.sqrt(np.mean(resid ** 2))) if len(resid) else float("nan")
    worst = float(np.max(np.abs(resid))) if len(resid) else float("nan")
    tol = model.tolerance(ch)
    floor = max(0.08, 1.5 * tol)  # sensor noise alone is ~0.05 V
    level = "high" if rms <= floor else "medium" if rms <= 2.5 * floor else "low"
    return {
        "channel": ch,
        "rms": round(rms, 3),
        "worst": round(worst, 3),
        "level": level,
        "window": [t0, t_dec],
        "observed": [[float(t), round(float(v), 4)] for t, v in zip(r["time_s"], r["observed"])],
        "model": [[float(t), round(float(v), 4)] for t, v in zip(r["time_s"], r["model"])],
    }


def _state(df: pd.DataFrame, t: float) -> dict[str, float]:
    out = {}
    for col in (BUS_V, BUS_I, BATT_V, BATT_I, SOLAR, HEATER, PAYLOAD):
        v = _median(df, col, t - 30, t)
        out[col] = v if v is not None else float(df[col].dropna().iloc[-1])
    return out


def preview(model: EpsModel, df: pd.DataFrame, channel: str, t_dec: float, option: str,
            horizon_s: float = PREVIEW_HORIZON_S, dt: float = 15.0, fit_rms: float = 0.0) -> dict[str, Any]:
    """Forecast a channel after an action at t_dec, with a band that widens with time.

    The band is at least the model's typical backtest error, and at least how badly it
    reproduced this case's own recent past (fit_rms): a model that can't explain what
    already happened gets a wide band.
    """
    p = model.params
    s = _state(df, t_dec)
    if option == "heater_off":
        d_bus_i = -s[HEATER]
    elif option == "payload_safe":
        d_bus_i = -(s[PAYLOAD] - p["payload_standby_a"])
    else:
        d_bus_i = 0.0
    step = predict_step(model, s, d_bus_i)
    k = battery_share(s[BATT_I], s[SOLAR], s[BUS_I])
    i_batt_after = s[BATT_I] - k * d_bus_i
    tol = max(model.tolerance(channel if channel in (BUS_V, BATT_V) else BUS_V), fit_rms)

    pts, band = [], []
    for n in range(int(horizon_s // dt) + 1):
        tau = n * dt
        drift = p["battery_v_per_ah"] * i_batt_after * tau / 3600.0
        if channel == BUS_V:
            v = s[BUS_V] + step[BUS_V] + drift
        elif channel == BATT_V:
            v = s[BATT_V] + step[BATT_V] + drift
        elif channel == PAYLOAD:
            v = p["payload_standby_a"] if option == "payload_safe" else s[PAYLOAD]
        elif channel == HEATER:
            v = 0.0 if option == "heater_off" else s[HEATER]
        else:
            return {"supported": False}
        half = (1.5 * tol + 0.02 * tau / 60.0) if channel in (BUS_V, BATT_V) else 0.05
        t = t_dec + tau
        pts.append([t, round(v, 4)])
        band.append([t, round(v - half, 4), round(v + half, 4)])
    return {"supported": True, "series": pts, "band": band, "d_bus_i": round(d_bus_i, 3)}


def whatif(model: EpsModel, df: pd.DataFrame, channel: str, family: str, t0: float, t1: float) -> dict[str, Any] | None:
    """Same window, with the suspect behaving like the healthy part the model learned."""
    p = model.params
    ch = channel if channel in (BUS_V, BATT_V) else BUS_V
    w = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)][["time_s", ch, BUS_I, BATT_I, SOLAR, HEATER, PAYLOAD, MODE]].dropna()
    if w.empty:
        return None
    times = w["time_s"].to_numpy()
    if family in ("heater", "payload"):
        if family == "heater":
            obs = w[HEATER].to_numpy()
            healthy = np.where(obs > 0.3, p["heater_healthy_a"], 0.0)
        else:
            obs = w[PAYLOAD].to_numpy()
            healthy = np.where(w[MODE].to_numpy() == "SCIENCE_MODE", p["payload_science_a"], p["payload_standby_a"])
        excess = obs - healthy
        k = np.array([battery_share(b, so, bu) for b, so, bu in zip(w[BATT_I], w[SOLAR], w[BUS_I])])
        d_batt = k * excess  # battery current that the extra load was costing
        ah = np.concatenate([[0.0], np.cumsum(np.diff(times) * d_batt[1:]) / 3600.0])
        lift = p["battery_ohm"] * d_batt + p["battery_v_per_ah"] * ah
        if ch == BUS_V:
            lift = lift + p["bus_harness_ohm"] * excess
        values = w[ch].to_numpy() + lift
        removed = "Heater B" if family == "heater" else "the payload"
    elif family == "battery":
        # Estimate this pack's resistance from the window, then swap in the learned healthy one.
        ib = w[BATT_I].to_numpy()
        r_case = _case_battery_ohm(df, t0, t1) or p["battery_ohm"]
        values = w[ch].to_numpy() + (p["battery_ohm"] - r_case) * (ib - 0.0)
        removed = "the battery pack"
    else:
        return None
    return {
        "removed": removed,
        "actual": [[float(t), round(float(v), 4)] for t, v in zip(times, w[ch])],
        "healthy": [[float(t), round(float(v), 4)] for t, v in zip(times, values)],
        "worst": round(float(values.min()), 2),
    }


def _case_battery_ohm(df: pd.DataFrame, t0: float, t1: float) -> float | None:
    w = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)]
    ib, vb = w[BATT_I].to_numpy(), w[BATT_V].to_numpy()
    if len(ib) < 10 or np.ptp(ib) < 0.5:
        return None
    slope = np.polyfit(ib, vb, 1)[0]
    return float(slope) if slope > 0 else None


def outcome(series: list[list[float]], t_from: float, limit: float, direction: str, settle_s: float = 60.0,
            band: list[list[float]] | None = None) -> dict[str, Any]:
    """Did the forecast get back to the healthy side of the warn and stay there?

    With a band, a forecast whose uncertainty straddles the warn is "borderline".
    """
    healthy = (lambda v: v > limit) if direction == "below" else (lambda v: v < limit)
    after = [(t, v) for t, v in series if t >= t_from]
    if not after:
        return {"clears": False}
    settled = [(t, v) for t, v in after if t >= t_from + settle_s] or after
    clears = all(healthy(v) for _, v in settled)
    worst = min(v for _, v in settled) if direction == "below" else max(v for _, v in settled)
    ten = next(((t, v) for t, v in after if t >= t_from + 600), after[-1])
    first = after[1] if len(after) > 1 else after[0]
    recover = next((t for t, v in after if healthy(v)), None)
    borderline = False
    if band:
        edge = [(t, lo if direction == "below" else hi) for t, lo, hi in band if t >= t_from + settle_s]
        other = [(t, hi if direction == "below" else lo) for t, lo, hi in band if t >= t_from + settle_s]
        if clears and not all(healthy(v) for _, v in edge):
            borderline = True
        if not clears and all(healthy(v) for _, v in other):
            borderline = True
    return {
        "clears": clears,
        "borderline": borderline,
        "first_value": round(first[1], 2),
        "value_10min": round(ten[1], 2),
        "worst": round(worst, 2),
        "recovered_in_s": round(recover - t_from, 1) if (recover is not None and clears) else None,
    }


@lru_cache(maxsize=1)
def _model_cached(stamp: str) -> EpsModel:
    return load_model()


def current_model() -> EpsModel:
    stamp = MODEL_JSON.stat().st_mtime if MODEL_JSON.exists() else 0
    return _model_cached(str(stamp))
