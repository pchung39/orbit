"""Demo-local source connectors: telemetry archive + library index.

Archive catalog is available for sealing. Opening a case copies a time
window into a new sealed run_id. Library sync rebuilds the search index.
ORBIT does not downlink or detect.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import SPEC_PATH, load_and_validate
from storage.store import (
    ROOT,
    events_for_run,
    ingest_documents,
    ingest_run,
    list_documents,
    list_runs,
    query_channel,
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


def archive_runs(conn: Any) -> list[dict[str, Any]]:
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
        "summary": f"Will seal a window from archive {meta['run_id']} · {meta['label']}",
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
    """Pick an archive (non-sealed) run to seal from. Returns (run_id, label)."""
    archives = {row["id"] for row in archive_runs(conn)}
    if source_run_id:
        if is_sealed_run_id(source_run_id):
            raise ValueError(f"{source_run_id} is already a sealed package — pick an archive tape")
        if source_run_id not in archives:
            raise ValueError(f"unknown archive run {source_run_id} — refresh Telemetry archive on Trust")
        preferred = ALARM_BIND.get(alarm)
        label = (preferred or {}).get("label") or source_run_id
        return source_run_id, label

    preferred = ALARM_BIND.get(alarm)
    if preferred and preferred["run_id"] in archives:
        return preferred["run_id"], preferred["label"]

    run_id = _fallback_run_with_crossing(conn, alarm, archives)
    if run_id is None:
        raise ValueError(
            f"no archive tape available for {alarm} — refresh the Telemetry archive on Trust"
        )
    return run_id, "first archive tape with a warn crossing"


def bind_run_for_alarm(conn: Any, alarm: str, alarm_time: str | None = None) -> tuple[str, str]:
    """Resolve archive source for an alarm (legacy name). Does not seal."""
    run_id, label = resolve_archive_run(conn, alarm, None)
    clock = parse_alarm_clock(alarm_time)
    notes = f"archive {run_id} · {label} · alarm @ {clock}"
    return run_id, notes


def _fallback_run_with_crossing(conn: Any, alarm: str, runs: set[str]) -> str | None:
    """Prefer any archive run whose alarm channel crosses its warn limit."""
    spec = load_and_validate(SPEC_PATH)
    meta = (spec.get("channels") or {}).get(alarm) or {}
    warn = meta.get("warn_limit")
    direction = meta.get("limit_direction")
    if warn is None:
        return next(iter(sorted(runs)), None)

    for run_id in sorted(runs):
        rows = query_channel(conn, run_id, alarm)
        for row in rows:
            val = row.get("value_num")
            if val is None:
                continue
            v = float(val)
            w = float(warn)
            crossed = (direction == "below" and v < w) or (direction == "above" and v > w)
            if crossed:
                return run_id
    return next(iter(sorted(runs)), None)


def _warn_crossing_time(conn: Any, run_id: str, alarm: str) -> float | None:
    spec = load_and_validate(SPEC_PATH)
    meta = (spec.get("channels") or {}).get(alarm) or {}
    warn = meta.get("warn_limit")
    direction = meta.get("limit_direction")
    if warn is None:
        return None
    for row in query_channel(conn, run_id, alarm):
        val = row.get("value_num")
        if val is None:
            continue
        v = float(val)
        w = float(warn)
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
    """Copy archive telemetry/events in a time window into a new sealed run_id.

    Returns (sealed_run_id, notes).
    """
    if is_sealed_run_id(source_run_id):
        raise ValueError(f"{source_run_id} is already sealed")

    source = conn.execute(
        "SELECT id, scenario, source_csv, started_at, notes FROM runs WHERE id = %s",
        (source_run_id,),
    ).fetchone()
    if source is None:
        raise ValueError(f"unknown archive run {source_run_id}")

    clock = parse_alarm_clock(alarm_time)
    center = _warn_crossing_time(conn, source_run_id, alarm)
    if center is None:
        try:
            center = float(clock_to_s(clock))
        except Exception as exc:
            raise ValueError(f"invalid alarm_time {alarm_time!r}") from exc

    t0 = max(0.0, float(center) - float(pad_before_s))
    t1 = float(center) + float(pad_after_s)
    sealed_id = _unique_sealed_id(conn, source_run_id, center)

    notes = (
        f"sealed from {source_run_id} · {alarm} @ {format_clock(center)} · "
        f"window {format_clock(t0)}–{format_clock(t1)} · {ADAPTER}"
    )
    conn.execute(
        "INSERT INTO runs (id, scenario, source_csv, started_at, notes) VALUES (%s, %s, %s, %s, %s)",
        (
            sealed_id,
            f"sealed:{source.get('scenario') or source_run_id}",
            source.get("source_csv"),
            source.get("started_at"),
            notes,
        ),
    )
    conn.execute(
        "INSERT INTO telemetry (run_id, time_s, timestamp, channel, value_num, value_text) "
        "SELECT %s, time_s, timestamp, channel, value_num, value_text "
        "FROM telemetry WHERE run_id = %s AND time_s >= %s AND time_s <= %s",
        (sealed_id, source_run_id, t0, t1),
    )
    conn.execute(
        "INSERT INTO events (run_id, time_s, timestamp, event_type, channel, detail) "
        "SELECT %s, time_s, timestamp, event_type, channel, detail "
        "FROM events WHERE run_id = %s AND time_s >= %s AND time_s <= %s",
        (sealed_id, source_run_id, t0, t1),
    )
    n = int(
        conn.execute(
            "SELECT COUNT(*) AS n FROM telemetry WHERE run_id = %s",
            (sealed_id,),
        ).fetchone()["n"]
    )
    if n == 0:
        conn.execute("DELETE FROM events WHERE run_id = %s", (sealed_id,))
        conn.execute("DELETE FROM runs WHERE id = %s", (sealed_id,))
        conn.commit()
        raise ValueError(
            f"no telemetry in window for {source_run_id} around {format_clock(center)} — "
            "check alarm time or refresh the archive"
        )
    conn.commit()
    _push_activity(
        "telemetry",
        f"Sealed {sealed_id} from {source_run_id} · {format_clock(t0)}–{format_clock(t1)}",
        {"sealed_run_id": sealed_id, "source_run_id": source_run_id, "samples": n},
    )
    return sealed_id, notes


def sync_telemetry(conn: Any) -> dict[str, Any]:
    """Refresh archive catalog runs (does not delete sealed packages)."""
    spec = load_and_validate(SPEC_PATH)
    total_samples = 0
    run_ids: list[str] = []
    for run_id, scenario, path, notes in _TELEMETRY_CATALOG:
        _ensure_run_csv(spec, run_id, path)
        if not path.exists():
            continue
        n = ingest_run(conn, path, run_id, scenario, events_for_run(spec, run_id), notes)
        total_samples += n
        run_ids.append(run_id)
    at = _now_iso()
    _last_sync["telemetry"] = at
    _push_activity(
        "telemetry",
        f"Archive refreshed · {len(run_ids)} tapes · {total_samples:,} sample frames",
        {"runs": run_ids, "samples": total_samples},
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
    archives = archive_runs(conn)
    sealed = sealed_runs(conn)
    last = _last_sync.get("telemetry")
    status = "synced" if archives else "empty"
    return {
        "id": "telemetry",
        "kind": "telemetry",
        "name": "Telemetry archive",
        "description": (
            "Upstream catalog for sealing. Opening a case copies a time window into a "
            "sealed evidence package — not a live downlink."
        ),
        "adapter": ADAPTER,
        "auto": False,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": None,
        "schedule": "on demand",
        "stats": {
            "runs": len(archives),
            "sealed": len(sealed),
            "label": f"{len(archives)} archive · {len(sealed)} sealed",
        },
    }


def connector_library(conn: Any) -> dict[str, Any]:
    docs = list_documents(conn)
    procedures = sum(1 for d in docs if d.get("kind") == "procedure")
    incidents = sum(1 for d in docs if d.get("kind") == "incident")
    last = _last_sync.get("library")
    status = "synced" if docs else "empty"
    return {
        "id": "library",
        "kind": "library",
        "name": "Library index",
        "description": (
            "Searchable procedures and prior close-outs. Sync rebuilds local embeddings "
            "on publish — not a live docs feed."
        ),
        "adapter": ADAPTER,
        "auto": False,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": None,
        "schedule": "on publish",
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
