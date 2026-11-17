"""Alarms in the connected history, and opening a case on one.

An alarm is a channel past its warn limit for at least two samples in a row
(single-sample glitches don't count). Alarms within a few minutes of each
other are one *episode*: a heater fault trips heater current, then heater
temperature, then bus voltage. ORBIT opens the case on the alarm its
procedures start from, and seals that window straight from the source.
"""

from __future__ import annotations

import json
from datetime import timedelta
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd

from simulator.scenarios import format_clock
from simulator.simulate import load_and_validate
from storage.evidence import SEALED_DIR, write_sealed_window

# Which alarm a case opens on when an episode trips several: the one the procedures start from.
ENTRY_PRIORITY = [
    "EPS.bus_voltage", "EPS.battery_voltage", "PAY.payload_current", "EPS.bus_current",
    "THM.heater_b_current", "THM.heater_b_temperature", "THM.battery_temperature", "PAY.power_draw",
]
EPISODE_GAP_S = 20 * 60.0
REARM_S = 15 * 60.0
LEAD_UP_S = 600.0
PAD_BEFORE_S, PAD_AFTER_S = 600.0, 300.0
COMMAND_CHANNEL = {
    "HEATER_B_ENABLE": "THM.heater_b_current", "HEATER_B_DISABLE": "THM.heater_b_current",
    "SCIENCE_MODE": "PAY.mode", "PAYLOAD_STANDBY": "PAY.mode",
}
LABELS = {
    "EPS.bus_voltage": "Bus voltage", "EPS.battery_voltage": "Battery voltage", "PAY.payload_current": "Payload current",
    "EPS.bus_current": "Bus current", "THM.heater_b_current": "Heater B current",
    "THM.heater_b_temperature": "Heater B temperature", "THM.battery_temperature": "Battery temperature",
    "PAY.power_draw": "Payload power",
}


def _iso(start: pd.Timestamp, t: float) -> str:
    return (start + timedelta(seconds=float(t))).isoformat()


def find_episodes() -> list[dict[str, Any]]:
    from storage.connectors import active_config

    return [dict(e, case=_case_for(e["key"])) for e in _episodes_cached(active_config().stamp)]


@lru_cache(maxsize=2)
def _episodes_cached(stamp: str) -> list[dict[str, Any]]:
    from storage.connectors import load_history

    tel, cmds, info = load_history()
    spec = load_and_validate()
    start = pd.Timestamp(info["start"])
    t = tel["time_s"].to_numpy()
    alarms = []
    for ch in ENTRY_PRIORITY:
        if ch not in tel:
            continue
        meta = spec["channels"][ch]
        lim, direction = meta.get("warn_limit"), meta.get("limit_direction")
        if lim is None:
            continue
        v = pd.to_numeric(tel[ch], errors="coerce").to_numpy()
        bad = (v < lim) if direction == "below" else (v > lim)
        bad = np.nan_to_num(bad, nan=False).astype(bool)
        persist = bad & np.concatenate([bad[1:], [False]])
        last = -1e18
        for i in np.where(persist)[0]:
            if t[i] - last > REARM_S:
                # Run until it has been back on the healthy side for three samples.
                j = i
                while j < len(v) - 3 and bad[j:j + 3].any():
                    j += 1
                seg = v[i:j + 1]
                worst = float(np.nanmin(seg) if direction == "below" else np.nanmax(seg))
                alarms.append({"channel": ch, "label": LABELS[ch], "t": float(t[i]), "clock": format_clock(t[i]),
                               "iso": _iso(start, t[i]), "value": round(float(v[i]), 2), "worst": round(worst, 2),
                               "limit": lim, "unit": meta.get("unit"), "direction": direction,
                               "duration_s": round(float(t[j] - t[i]), 0)})
            last = t[i]
    alarms.sort(key=lambda a: a["t"])

    episodes: list[dict[str, Any]] = []
    for a in alarms:
        if episodes and a["t"] - episodes[-1]["start_t"] <= EPISODE_GAP_S:
            episodes[-1]["alarms"].append(a)
        else:
            episodes.append({"start_t": a["t"], "alarms": [a]})
    out = []
    for ep in episodes:
        primary = min(ep["alarms"], key=lambda a: ENTRY_PRIORITY.index(a["channel"]))
        lead = cmds[(cmds["time_s"] >= ep["start_t"] - LEAD_UP_S) & (cmds["time_s"] <= primary["t"])]
        out.append({
            "key": f"{primary['channel']}@{int(primary['t'])}",
            "start_iso": _iso(start, ep["start_t"]),
            "primary": primary,
            "alarms": ep["alarms"],
            "lead_up": [{"t": float(r.time_s), "clock": format_clock(r.time_s), "command": r.command,
                         "source_name": r.source_name, "mapped": bool(r.mapped)} for r in lead.itertuples()],
        })
    return out


def _case_for(key: str) -> str | None:
    """Incident already opened on this alarm, if any (looked up via the sealed windows)."""
    if not SEALED_DIR.exists():
        return None
    for meta_path in SEALED_DIR.glob("sealed_history_*.json"):
        meta = json.loads(meta_path.read_text())
        if meta.get("history_alarm_key") == key:
            from storage.store import connect

            try:
                with connect() as conn:
                    row = conn.execute("SELECT id FROM incidents WHERE run_id = %s ORDER BY id LIMIT 1",
                                       (meta["id"],)).fetchone()
                return row["id"] if row else None
            except Exception:
                return None
    return None


def seal_episode(key: str) -> tuple[str, str, dict[str, Any]]:
    """Cut the window around an episode's primary alarm from the connected source and seal it."""
    from storage.connectors import active_config, load_history

    episode = next((e for e in find_episodes() if e["key"] == key), None)
    if episode is None:
        raise ValueError("that alarm isn't in the connected history any more")
    tel, cmds, info = load_history()
    primary = episode["primary"]
    t_alarm = primary["t"]
    t0, t1 = t_alarm - PAD_BEFORE_S, t_alarm + PAD_AFTER_S
    window = tel[(tel["time_s"] >= t0) & (tel["time_s"] <= t1)].copy()
    if window.empty:
        raise ValueError("no telemetry around that alarm (it may fall in a gap)")
    keep = ["time_s", "timestamp"] + [c for c in window.columns if c not in ("time_s", "timestamp")]
    window = window[keep]
    in_win = cmds[(cmds["time_s"] >= t0) & (cmds["time_s"] <= t1)]
    events = []
    for r in in_win.itertuples():
        mode_change = r.command in ("SCIENCE_MODE", "PAYLOAD_STANDBY")
        events.append({
            "time_s": float(r.time_s),
            "event_type": "mode_change" if mode_change else "command",
            "channel": COMMAND_CHANNEL.get(r.command, "unmapped") if r.mapped else "unmapped",
            "detail": r.command,
        })
    cfg = active_config()
    date = pd.Timestamp(primary["iso"]).strftime("%b %-d")
    notes = (f"sealed from history · {cfg.name} · {primary['channel']} @ {date} {primary['clock']} UTC · "
             f"window {format_clock(t0)}–{format_clock(t1)}")
    sealed_id = write_sealed_window(
        "history", "history", primary["channel"], t_alarm, t0, t1, window, notes,
        extra={"events": events, "history_alarm_key": key, "history_source": cfg.name,
               "history_kind": cfg.kind, "alarm_iso": primary["iso"]},
    )
    return sealed_id, notes, episode


def episode_title(episode: dict[str, Any]) -> str:
    p = episode["primary"]
    when = pd.Timestamp(p["iso"]).strftime("%b %-d %H:%M")
    return f"{p['label']} warn · {when} UTC"
