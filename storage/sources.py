"""Demo-local source connectors: telemetry archive + library sync.

Real HTTP contract for Trust; adapters call existing ingest paths.
ORBIT still does not downlink or detect — sync keeps sealed tapes warm.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from simulator.scenarios import clock_to_s
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
SYNC_INTERVAL_MIN = 15

# Preferred sealed tape when an operator opens a case on an entry alarm.
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


def _next_sync_iso(last_iso: str | None) -> str:
    base = datetime.now(timezone.utc)
    if last_iso:
        try:
            base = datetime.strptime(last_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    nxt = base + timedelta(minutes=SYNC_INTERVAL_MIN)
    return nxt.strftime("%Y-%m-%dT%H:%M:%SZ")


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


def bind_preview(alarm: str) -> dict[str, str] | None:
    meta = ALARM_BIND.get(alarm)
    if not meta:
        return None
    return {
        "run_id": meta["run_id"],
        "label": meta["label"],
        "adapter": ADAPTER,
        "summary": f"Attaches demo tape {meta['run_id']} · {meta['label']}",
    }


def bind_run_for_alarm(conn: Any, alarm: str, alarm_time: str | None = None) -> tuple[str, str]:
    """Return (run_id, notes) for a sealed demo tape matching the entry alarm."""
    runs = {row["id"] for row in list_runs(conn)}
    preferred = ALARM_BIND.get(alarm)
    if preferred and preferred["run_id"] in runs:
        run_id = preferred["run_id"]
        label = preferred["label"]
    else:
        run_id = _fallback_run_with_crossing(conn, alarm, runs)
        label = "first ingested tape with a warn crossing"
        if run_id is None:
            raise ValueError(
                f"no sealed tape available for {alarm} — sync the Telemetry archive on Trust"
            )

    clock = parse_alarm_clock(alarm_time)
    notes = f"bound from {ADAPTER} · run {run_id} · {label} · alarm @ {clock}"
    return run_id, notes


def _fallback_run_with_crossing(conn: Any, alarm: str, runs: set[str]) -> str | None:
    """Prefer any ingested run whose alarm channel crosses its warn limit."""
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


def sync_telemetry(conn: Any) -> dict[str, Any]:
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
        f"Synced {len(run_ids)} tapes · {total_samples:,} sample frames",
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
        f"Re-embedded {n_docs} documents · {procedures} procedures · {incidents} priors",
        {"documents": n_docs, "procedures": procedures, "incidents": incidents},
    )
    return connector_library(conn)


def connector_telemetry(conn: Any) -> dict[str, Any]:
    runs = list_runs(conn)
    last = _last_sync.get("telemetry")
    status = "synced" if runs else "empty"
    return {
        "id": "telemetry",
        "kind": "telemetry",
        "name": "Telemetry archive",
        "description": "Sealed simulator tapes. Sync keeps Postgres warm — not a live downlink.",
        "adapter": ADAPTER,
        "auto": True,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": _next_sync_iso(last),
        "stats": {
            "runs": len(runs),
            "label": f"{len(runs)} tapes",
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
        "name": "Library",
        "description": "Procedures and prior close-outs. Local embeddings for semantic search.",
        "adapter": ADAPTER,
        "auto": True,
        "status": status,
        "last_sync_at": last,
        "next_sync_at": _next_sync_iso(last),
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
