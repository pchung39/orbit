"""Demo-local archive adapter + library index.

Upstream archive = catalog of full tapes (CSV stand-in). Opening a case
*fetches* a time window from that archive and stores only the sealed
package in ORBIT. Library sync rebuilds the search index.
ORBIT does not downlink, detect, or keep the full archive as its store.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import SPEC_PATH, load_and_validate
from storage.store import (
    ROOT,
    SPEC_CHANNELS,
    events_for_run,
    ingest_documents,
    list_documents,
    list_runs,
    _ensure_run_csv,
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

_TELEMETRY_CATALOG = (
    ("eps204", "eps204", ROOT / "runs" / "eps204.csv", "demo: heater fault + science-mode confounder"),
    ("fault1", "fault1", ROOT / "runs" / "fault1.csv", "heater fault only"),
    ("marg001", "marg001", ROOT / "runs" / "marg001.csv", "decoy EPS-204: marginal heater, withhold cause"),
    ("inc0187", "inc0187", ROOT / "runs" / "inc0187.csv", "prior incident source run"),
    ("pay002", "pay002", ROOT / "runs" / "pay002.csv", "payload overcurrent on SCIENCE_MODE"),
    ("inc0191", "inc0191", ROOT / "runs" / "inc0191.csv", "prior payload-spike source run"),
    ("batt003", "batt003", ROOT / "runs" / "batt003.csv", "pack IR sag, heater healthy"),
    ("inc0162", "inc0162", ROOT / "runs" / "inc0162.csv", "prior pack-IR source run"),
    ("nominal", "nominal", ROOT / "runs" / "nominal.csv", "healthy SCIENCE_MODE control tape"),
)

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
    spec = load_and_validate(SPEC_PATH)
    out: list[dict[str, Any]] = []
    for run_id, scenario, path, notes in _TELEMETRY_CATALOG:
        _ensure_run_csv(spec, run_id, path)
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
    return [row for row in list_runs(conn) if not is_sealed_run_id(row["id"])]


def sealed_runs(conn: Any) -> list[dict[str, Any]]:
    return [row for row in list_runs(conn) if is_sealed_run_id(row["id"])]


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


def _unique_sealed_id(conn: Any, source_run_id: str, center_s: float) -> str:
    existing = {row["id"] for row in list_runs(conn)}
    clock_part = format_clock(center_s).replace(":", "")
    for _ in range(8):
        candidate = f"sealed_{source_run_id}_{clock_part}_{secrets.token_hex(2)}"
        if candidate not in existing:
            return candidate
    raise ValueError("could not allocate a unique sealed run id")


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
    spec = load_and_validate(SPEC_PATH)
    _ensure_run_csv(spec, source_run_id, path)
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

    sealed_id = _unique_sealed_id(conn, source_run_id, center)
    started = str(window["timestamp"].iloc[0])
    notes = (
        f"sealed from {source_run_id} · {alarm} @ {format_clock(center)} · "
        f"window {format_clock(t0)}–{format_clock(t1)} · fetch-on-seal · {ADAPTER}"
    )
    conn.execute(
        "INSERT INTO runs (id, scenario, source_csv, started_at, notes) VALUES (%s, %s, %s, %s, %s)",
        (sealed_id, f"sealed:{scenario}", str(path), started, notes),
    )

    rows: list[tuple[Any, ...]] = []
    for rec in window.to_dict(orient="records"):
        time_s = float(rec["time_s"])
        timestamp = str(rec["timestamp"])
        for channel in SPEC_CHANNELS:
            if channel not in rec:
                continue
            raw = rec[channel]
            if channel == "PAY.mode":
                rows.append((sealed_id, time_s, timestamp, channel, None, str(raw)))
            else:
                try:
                    rows.append((sealed_id, time_s, timestamp, channel, float(raw), None))
                except (TypeError, ValueError):
                    rows.append((sealed_id, time_s, timestamp, channel, None, str(raw)))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO telemetry (run_id, time_s, timestamp, channel, value_num, value_text) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )

    event_rows = []
    for time_s, event_type, channel, detail in events_for_run(spec, source_run_id):
        if time_s < t0 or time_s > t1:
            continue
        idx = (window["time_s"] - time_s).abs().idxmin()
        ts = str(window.loc[idx, "timestamp"])
        event_rows.append((sealed_id, time_s, ts, event_type, channel, detail))
    if event_rows:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO events (run_id, time_s, timestamp, event_type, channel, detail) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                event_rows,
            )

    conn.commit()
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
        f"Archive catalog refreshed · {len(available)}/{len(catalog)} tapes reachable upstream",
        {"runs": [row["id"] for row in available]},
    )
    return connector_telemetry(conn)


def sync_library(conn: Any) -> dict[str, Any]:
    spec = load_and_validate(SPEC_PATH)
    n_docs = ingest_documents(conn, spec)
    at = _now_iso()
    _last_sync["library"] = at
    docs = list_documents(conn)
    procedures = sum(1 for d in docs if d.get("kind") == "procedure")
    incidents = sum(1 for d in docs if d.get("kind") == "incident")
    _push_activity(
        "library",
        f"Library index rebuilt · {n_docs} documents · {procedures} procedures · {incidents} priors",
        {"documents": n_docs, "procedures": procedures, "incidents": incidents},
    )
    return connector_library(conn)


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
            "Upstream tape catalog. Opening a case fetches a warn±pad window and stores "
            "only that sealed package in ORBIT — not the full orbit, not a live downlink."
        ),
        "adapter": ADAPTER,
        "auto": False,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": None,
        "schedule": "on demand",
        "action_label": "Refresh catalog",
        "stats": {
            "catalog": len(available),
            "sealed": len(sealed),
            "label": f"{len(available)} upstream · {len(sealed)} sealed in ORBIT",
        },
    }


def connector_library(conn: Any) -> dict[str, Any]:
    docs = list_documents(conn)
    procedures = sum(1 for d in docs if d.get("kind") == "procedure")
    incidents = sum(1 for d in docs if d.get("kind") == "incident")
    last = _last_sync.get("library")
    status = "ready" if docs else "empty"
    return {
        "id": "library",
        "kind": "library",
        "role": "index",
        "name": "Library index",
        "description": (
            "Procedures and prior close-outs ORBIT searches during investigation. "
            "Rebuild embeddings on publish — not a live docs feed."
        ),
        "adapter": ADAPTER,
        "auto": False,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": None,
        "schedule": "on publish",
        "action_label": "Rebuild index",
        "stats": {
            "documents": len(docs),
            "procedures": procedures,
            "incidents": incidents,
            "label": f"{procedures} procedures · {incidents} priors",
        },
    }


def list_connectors(conn: Any) -> list[dict[str, Any]]:
    return [connector_telemetry(conn), connector_library(conn)]


def sync_connector(conn: Any, connector_id: str) -> dict[str, Any]:
    if connector_id == "telemetry":
        return sync_telemetry(conn)
    if connector_id == "library":
        return sync_library(conn)
    raise ValueError(f"unknown connector {connector_id}")
