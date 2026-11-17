"""Mission history as a data source: what's there, and what's wrong with it.

Today the only history source is the generated dummy mission (CSV files). The
summary is what the Sources page shows: coverage by day, gaps, glitches, and
which commands ORBIT can interpret.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd


MAPPED_MEANING = {
    "HEATER_B_ENABLE": "Turns Heater B on",
    "HEATER_B_DISABLE": "Turns Heater B off",
    "SCIENCE_MODE": "Payload into science mode",
    "PAYLOAD_STANDBY": "Payload back to standby",
}


def source_summary() -> dict[str, Any]:
    from storage.connectors import active_config

    cfg = active_config()
    return _summary_cached(json.dumps({"stamp": cfg.stamp, "name": cfg.name}))


@lru_cache(maxsize=2)
def _summary_cached(key: str) -> dict[str, Any]:
    from storage.connectors import active_config, load_history, masked

    cfg = active_config()
    tel, cmds, info = load_history(cfg)
    dt = float(info["sample_interval_s"])
    t = tel["time_s"].to_numpy()
    days = int(info["days"])

    gaps_idx = np.where(np.diff(t) > 2 * dt)[0]
    gaps = [{"start": float(t[i] + dt), "end": float(t[i + 1]), "minutes": round((t[i + 1] - t[i] - dt) / 60, 1)}
            for i in gaps_idx]

    v = tel["EPS.bus_voltage"] if "EPS.bus_voltage" in tel else pd.Series(dtype=float)
    smooth = v.rolling(7, center=True, min_periods=3).median()
    glitches = int(((v - smooth).abs() > 1.0).sum())

    per_day = []
    expected = 86400.0 / dt
    for d in range(days):
        n = int(((t >= d * 86400) & (t < (d + 1) * 86400)).sum())
        per_day.append(round(min(1.0, n / expected), 4))

    counts: dict[tuple[str, str, bool], int] = {}
    for _, row in cmds.iterrows():
        key2 = (row["source_name"], row["command"], bool(row["mapped"]))
        counts[key2] = counts.get(key2, 0) + 1
    commands = [
        {"name": src, "orbit": orbit if mapped else None, "count": n, "mapped": mapped,
         "meaning": MAPPED_MEANING.get(orbit) if mapped else None}
        for (src, orbit, mapped), n in sorted(counts.items(), key=lambda kv: (not kv[0][2], -kv[1]))
    ]
    missing_h = round(sum(g["minutes"] for g in gaps) / 60, 1)
    scaled = [{"orbit": o, "source": m["source"], "scale": m.get("scale", 1.0)}
              for o, m in cfg.channels.items() if float(m.get("scale", 1.0)) != 1.0]
    return {
        "name": info["name"],
        "kind": info["kind"],
        "source_kind": cfg.kind,
        "url": masked(cfg.url),
        "table": cfg.table,
        "synthetic": info["synthetic"],
        "stamp": cfg.stamp,
        "start": info["start"],
        "end": info["end"],
        "days": days,
        "sample_interval_s": dt,
        "rows": info["rows"],
        "load_seconds": info["load_seconds"],
        "channels": info["channels"],
        "mapped_channels": [{"orbit": o, "source": m["source"], "scale": m.get("scale", 1.0)} for o, m in cfg.channels.items()],
        "scaled": scaled,
        "coverage_pct": round(100 * len(t) / (days * expected), 1),
        "per_day": per_day,
        "gaps": {"count": len(gaps), "missing_hours": missing_h,
                 "longest_minutes": max((g["minutes"] for g in gaps), default=0), "list": gaps},
        "glitches": glitches,
        "commands": commands,
        "unmapped": [c for c in commands if not c["mapped"]],
        "saved_at": cfg.saved_at,
    }
