"""Demo-local archive adapter.

Upstream archive = catalog of full tapes (CSV stand-in). Opening a case
fetches a time window from that archive and writes a sealed file.
ORBIT does not downlink, detect, or keep the full archive in Postgres.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pandas as pd

from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import SPEC_PATH, load_and_validate
from storage.evidence import (
    ARCHIVE as _TELEMETRY_CATALOG,
    ensure_archive_csv,
    list_runs,
    write_sealed_window,
)

ADAPTER = "demo-local"
PAD_BEFORE_S = 600.0
PAD_AFTER_S = 300.0

# Preferred archive tape when an operator opens a case on an entry alarm.
ALARM_BIND: dict[str, dict[str, str]] = {
    "EPS.bus_voltage": {
        "run_id": "fault1",
        "label": "heater-only bus sag",
    },
    "PAY.payload_current": {
        "run_id": "pay002",
        "label": "payload overcurrent on SCIENCE_MODE",
    },
    "EPS.battery_voltage": {
        "run_id": "batt003",
        "label": "pack IR sag, heater healthy",
    },
    "EPS.bus_current": {
        "run_id": "eps204",
        "label": "heater fault + science-mode confounder",
    },
    "THM.heater_b_current": {
        "run_id": "fault1",
        "label": "heater-only overcurrent",
    },
    "THM.heater_b_temperature": {
        "run_id": "fault1",
        "label": "heater-only overcurrent",
    },
    "EPS.solar_array_current": {
        "run_id": "nominal",
        "label": "healthy SCIENCE_MODE control",
    },
}

_activity: list[dict[str, Any]] = []
_last_sync: dict[str, str] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _push_activity(connector_id: str, message: str, detail: dict[str, Any] | None = None) -> None:
    _activity.insert(
        0,
        {
            "at": _now_iso(),
            "connector": connector_id,
            "message": message,
            "detail": detail or {},
        },
    )
    del _activity[20:]


def list_activity(limit: int = 20) -> list[dict[str, Any]]:
    return list(_activity[: max(1, min(limit, 50))])


def is_sealed_run_id(run_id: str) -> bool:
    return str(run_id).startswith("sealed_")


def _catalog_tuple(run_id: str) -> tuple[str, str, Any, str] | None:
    for row in _TELEMETRY_CATALOG:
        if row[0] == run_id:
            return row
    return None


def list_archive_catalog() -> list[dict[str, Any]]:
    """Upstream archive inventory (metadata). Does not require Postgres ingest."""
    out: list[dict[str, Any]] = []
    for run_id, scenario, path, notes in _TELEMETRY_CATALOG:
        ensure_archive_csv(run_id, path)
        entry: dict[str, Any] = {
            "id": run_id,
            "scenario": scenario,
            "notes": notes,
            "kind": "archive",
            "adapter": ADAPTER,
            "available": path.exists(),
            "source_csv": str(path) if path.exists() else None,
            "samples": 0,
            "clock_start": None,
            "clock_end": None,
        }
        if path.exists():
            try:
                df = pd.read_csv(path, usecols=["time_s", "timestamp"])
                if len(df):
                    entry["samples"] = int(len(df))
                    entry["clock_start"] = format_clock(float(df["time_s"].iloc[0]))
                    entry["clock_end"] = format_clock(float(df["time_s"].iloc[-1]))
            except Exception:
                entry["available"] = False
        out.append(entry)
    return out


def archive_runs(conn: Any) -> list[dict[str, Any]]:
    """Legacy: archive rows still cached in Postgres (demo inspect / seeds)."""
    return [row for row in list_runs() if not is_sealed_run_id(row["id"])]


def sealed_runs(conn: Any) -> list[dict[str, Any]]:
    return [row for row in list_runs() if is_sealed_run_id(row["id"])]


def bind_preview(alarm: str) -> dict[str, str] | None:
    meta = ALARM_BIND.get(alarm)
    if not meta:
        return None
    return {
        "run_id": meta["run_id"],
        "label": meta["label"],
        "adapter": ADAPTER,
        "summary": f"Will fetch+seal a window from archive {meta['run_id']} · {meta['label']}",
    }


def parse_alarm_clock(alarm_time: str | None) -> str:
    """Normalize to HH:MM:SS for notes; accept ISO suffix or bare clock."""
    raw = (alarm_time or "").strip()
    if not raw:
        return "14:32:00"
    if "T" in raw:
        try:
            part = raw.split("T", 1)[1]
            part = part.rstrip("Zz")
            if len(part) >= 8:
                return part[:8]
        except Exception:
            pass
    if len(raw) == 5 and raw[2] == ":":
        return f"{raw}:00"
    try:
        clock_to_s(raw[:8] if len(raw) >= 8 else raw)
        return raw[:8] if len(raw) >= 8 else raw
    except Exception:
        return raw


def resolve_archive_run(conn: Any, alarm: str, source_run_id: str | None = None) -> tuple[str, str]:
    """Pick an upstream archive tape to seal from. Returns (run_id, label)."""
    catalog = {row["id"]: row for row in list_archive_catalog() if row.get("available")}
    if source_run_id:
        if is_sealed_run_id(source_run_id):
            raise ValueError(f"{source_run_id} is already a sealed package — pick an archive tape")
        if source_run_id not in catalog:
            raise ValueError(f"unknown archive run {source_run_id} — refresh the archive catalog on Trust")
        preferred = ALARM_BIND.get(alarm)
        label = (preferred or {}).get("label") or source_run_id
        return source_run_id, label

    preferred = ALARM_BIND.get(alarm)
    if preferred and preferred["run_id"] in catalog:
        return preferred["run_id"], preferred["label"]

    run_id = _fallback_run_with_crossing(alarm, set(catalog))
    if run_id is None:
        raise ValueError(
            f"no archive tape available for {alarm} — refresh the archive catalog on Trust"
        )
    return run_id, "first archive tape with a warn crossing"


def bind_run_for_alarm(conn: Any, alarm: str, alarm_time: str | None = None) -> tuple[str, str]:
    """Resolve archive source for an alarm (legacy name). Does not seal."""
    run_id, label = resolve_archive_run(conn, alarm, None)
    clock = parse_alarm_clock(alarm_time)
    notes = f"archive {run_id} · {label} · alarm @ {clock}"
    return run_id, notes


def _fallback_run_with_crossing(alarm: str, runs: set[str]) -> str | None:
    """Prefer any catalog tape whose alarm channel crosses its warn limit."""
    spec = load_and_validate(SPEC_PATH)
    meta = (spec.get("channels") or {}).get(alarm) or {}
    warn = meta.get("warn_limit")
    direction = meta.get("limit_direction")
    if warn is None:
        return next(iter(sorted(runs)), None)

    for run_id in sorted(runs):
        entry = _catalog_tuple(run_id)
        if not entry or not entry[2].exists():
            continue
        try:
            df = pd.read_csv(entry[2], usecols=["time_s", alarm])
        except Exception:
            continue
        for _, row in df.iterrows():
            val = row.get(alarm)
            if pd.isna(val):
                continue
            v = float(val)
            w = float(warn)
            crossed = (direction == "below" and v < w) or (direction == "above" and v > w)
            if crossed:
                return run_id
    return next(iter(sorted(runs)), None)


def _warn_crossing_time_df(df: Any, alarm: str) -> float | None:
    spec = load_and_validate(SPEC_PATH)
    meta = (spec.get("channels") or {}).get(alarm) or {}
    warn = meta.get("warn_limit")
    direction = meta.get("limit_direction")
    if warn is None or alarm not in df.columns:
        return None
    w = float(warn)
    for _, row in df.iterrows():
        val = row.get(alarm)
        if pd.isna(val):
            continue
        v = float(val)
        crossed = (direction == "below" and v < w) or (direction == "above" and v > w)
        if crossed:
            return float(row["time_s"])
    return None


def seal_run_window(
    conn: Any,
    source_run_id: str,
    alarm: str,
    alarm_time: str | None = None,
    *,
    pad_before_s: float = PAD_BEFORE_S,
    pad_after_s: float = PAD_AFTER_S,
) -> tuple[str, str]:
    """Fetch a time window from the upstream archive CSV and store only the sealed package.

    Returns (sealed_run_id, notes). Full archive tapes are not required in Postgres.
    """
    if is_sealed_run_id(source_run_id):
        raise ValueError(f"{source_run_id} is already sealed")

    entry = _catalog_tuple(source_run_id)
    if entry is None:
        raise ValueError(f"unknown archive run {source_run_id}")
    _, scenario, path, _notes = entry
    ensure_archive_csv(source_run_id, path)
    if not path.exists():
        raise ValueError(f"archive tape {source_run_id} not available upstream")

    df = pd.read_csv(path)
    if "time_s" not in df.columns:
        raise ValueError(f"archive tape {source_run_id} missing time_s")

    clock = parse_alarm_clock(alarm_time)
    center = _warn_crossing_time_df(df, alarm)
    if center is None:
        try:
            center = float(clock_to_s(clock))
        except Exception as exc:
            raise ValueError(f"invalid alarm_time {alarm_time!r}") from exc

    t0 = max(0.0, float(center) - float(pad_before_s))
    t1 = float(center) + float(pad_after_s)
    window = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)]
    if window.empty:
        raise ValueError(
            f"no telemetry in window for {source_run_id} around {format_clock(center)} — "
            "check alarm time or refresh the archive catalog"
        )

    notes = (
        f"sealed from {source_run_id} · {alarm} @ {format_clock(center)} · "
        f"window {format_clock(t0)}–{format_clock(t1)} · fetch-on-seal · {ADAPTER}"
    )
    sealed_id = write_sealed_window(
        source_run_id,
        scenario,
        alarm,
        float(center),
        t0,
        t1,
        window,
        notes,
    )
    n = len(window)
    _push_activity(
        "telemetry",
        f"Fetched+sealed {sealed_id} from archive {source_run_id} · {format_clock(t0)}–{format_clock(t1)}",
        {"sealed_run_id": sealed_id, "source_run_id": source_run_id, "frames": n},
    )
    return sealed_id, notes


def sync_telemetry(conn: Any) -> dict[str, Any]:
    """Refresh upstream archive catalog (ensure tapes exist). Does not load full orbits into ORBIT."""
    catalog = list_archive_catalog()
    available = [row for row in catalog if row.get("available")]
    at = _now_iso()
    _last_sync["telemetry"] = at
    _push_activity(
        "telemetry",
        f"Tape list updated · {len(available)}/{len(catalog)} reachable upstream",
        {"runs": [row["id"] for row in available]},
    )
    return connector_telemetry(conn)


def connector_telemetry(conn: Any) -> dict[str, Any]:
    catalog = list_archive_catalog()
    available = [row for row in catalog if row.get("available")]
    sealed = sealed_runs(conn)
    last = _last_sync.get("telemetry")
    status = "ready" if available else "empty"
    return {
        "id": "telemetry",
        "kind": "telemetry",
        "role": "upstream",
        "name": "Mission archive",
        "description": (
            "Tapes you can open a case from. Opening a case copies a warn±pad window and seals it. "
            "Already-sealed cases do not change."
        ),
        "adapter": ADAPTER,
        "auto": False,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": None,
        "schedule": None,
        "action_label": "Update tape list" if available else "Connect archive",
        "stats": {
            "catalog": len(available),
            "sealed": len(sealed),
            "label": f"{len(available)} upstream · {len(sealed)} sealed in ORBIT",
        },
    }


def list_connectors(conn: Any) -> list[dict[str, Any]]:
    return [connector_telemetry(conn)]


def sync_connector(conn: Any, connector_id: str) -> dict[str, Any]:
    if connector_id == "telemetry":
        return sync_telemetry(conn)
    raise ValueError(f"unknown connector {connector_id}")
