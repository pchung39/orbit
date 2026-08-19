"""ORBIT HTTP API. Read-only investigation workspace.

Does not command the spacecraft. Investigation uses --provider rules only
(no paid LLM). Same store the CLI uses. Serves the ops console at /.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent.closeout import build_closeout
from agent.investigate import investigate_rules
from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import load_and_validate
from storage.store import (
    connect,
    create_incident,
    ensure_demo_incident,
    file_incident,
    get_document,
    get_incident,
    init_schema,
    list_documents,
    list_incidents,
    list_runs,
    mark_incident_recommended,
    query_channel,
    query_events,
    search_documents,
)

UI_DIR = Path(__file__).resolve().parent.parent / "ui"

WORKSPACE_CHANNELS = (
    "EPS.bus_voltage",
    "EPS.bus_current",
    "EPS.battery_voltage",
    "EPS.solar_array_current",
    "THM.heater_b_current",
    "PAY.payload_current",
    "PAY.mode",
    "THM.heater_b_temperature",
)

DESK_CHANNELS = (
    "EPS.bus_voltage",
    "EPS.bus_current",
    "THM.heater_b_current",
    "PAY.mode",
    "EPS.battery_voltage",
    "EPS.solar_array_current",
)

DESK_TITLES = {
    "EPS.bus_voltage": "Bus voltage",
    "EPS.bus_current": "Bus current",
    "THM.heater_b_current": "Heater B",
    "PAY.mode": "Payload mode",
    "EPS.battery_voltage": "Battery voltage",
    "EPS.solar_array_current": "Solar array",
}

class IncidentIn(BaseModel):
    run_id: str
    alarm: str
    title: str | None = Field(default=None)


def _entry_alarms(spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for name, meta in spec["channels"].items():
        if meta.get("warn_limit") is None:
            continue
        out.append(
            {
                "id": name,
                "unit": meta.get("unit"),
                "warn_limit": meta.get("warn_limit"),
                "physical_meaning": meta.get("physical_meaning"),
            }
        )
    return out


app = FastAPI(
    title="ORBIT",
    description="Assemble telemetry, commands, procedures, and incidents. Does not command the spacecraft.",
)


def _conn():
    conn = connect()
    init_schema(conn)
    return conn


def _row(row: Any) -> dict[str, Any]:
    data = dict(row)
    if data.get("time_s") is not None:
        data["time_s"] = float(data["time_s"])
        data["clock"] = format_clock(data["time_s"])
    if data.get("value_num") is not None:
        data["value_num"] = float(data["value_num"])
    if data.get("score") is not None:
        data["score"] = float(data["score"])
    return data


def _downsample(rows: list[dict[str, Any]], n: int = 52) -> list[dict[str, Any]]:
    if len(rows) <= n:
        return rows
    step = (len(rows) - 1) / (n - 1)
    return [rows[round(i * step)] for i in range(n)]


def _limit_crossed(value: float | None, limit: Any, direction: str | None) -> bool:
    if value is None or limit is None or direction in (None, "not_applicable"):
        return False
    if direction == "below":
        return value < float(limit)
    if direction == "above":
        return value > float(limit)
    if direction == "above_absolute_value":
        return abs(value) > float(limit)
    return False


def _spark_point(row: dict[str, Any]) -> dict[str, Any]:
    time_s = float(row["time_s"])
    value = row.get("value_num")
    return {
        "time_s": time_s,
        "clock": format_clock(time_s),
        "value_num": float(value) if value is not None else None,
        "value_text": row.get("value_text"),
    }


def _desk_channel(spec: dict[str, Any], name: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    meta = spec["channels"][name]
    last = rows[-1] if rows else None
    warn = meta.get("warn_limit")
    crit = meta.get("critical_limit")
    direction = meta.get("limit_direction")
    value = last.get("value_num") if last else None
    if value is not None:
        value = float(value)
    state = "nominal"
    if last and name != "PAY.mode":
        if _limit_crossed(value, crit, direction):
            state = "critical"
        elif _limit_crossed(value, warn, direction):
            state = "warn"
    crossed = None
    if name != "PAY.mode" and warn is not None:
        for row in rows:
            num = row.get("value_num")
            if num is None:
                continue
            if _limit_crossed(float(num), warn, direction):
                time_s = float(row["time_s"])
                crossed = {
                    "time_s": time_s,
                    "clock": format_clock(time_s),
                    "value_num": float(num),
                }
                break
    return {
        "id": name,
        "title": DESK_TITLES.get(name, name),
        "subsystem": meta.get("subsystem"),
        "unit": "" if name == "PAY.mode" else (meta.get("unit") or ""),
        "warn_limit": warn,
        "critical_limit": crit,
        "limit_direction": direction,
        "nominal_range": meta.get("nominal_range"),
        "value_num": value,
        "value_text": last.get("value_text") if last else None,
        "time_s": float(last["time_s"]) if last else None,
        "clock": format_clock(float(last["time_s"])) if last else None,
        "state": state,
        "crossed": crossed,
        "spark": [_spark_point(row) for row in _downsample(rows)],
    }


def _channel_card(spec: dict[str, Any], name: str) -> dict[str, Any]:
    meta = spec["channels"][name]
    return {
        "id": name,
        "subsystem": meta.get("subsystem"),
        "unit": meta.get("unit"),
        "physical_meaning": meta.get("physical_meaning"),
        "nominal_range": meta.get("nominal_range"),
        "warn_limit": meta.get("warn_limit"),
        "critical_limit": meta.get("critical_limit"),
        "limit_direction": meta.get("limit_direction"),
        "values": meta.get("values"),
    }


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/desk")
def desk(run_id: str | None = Query(default=None)) -> dict[str, Any]:
    """Last samples on a tape. Not a live downlink. ORBIT does not detect."""
    spec = load_and_validate()
    with _conn() as conn:
        ensure_demo_incident(conn)
        runs = list_runs(conn)
        if not runs:
            return {
                "run_id": None,
                "clock": None,
                "time_s": None,
                "scope": "Last sample on this tape. Not a live downlink.",
                "orbit": None,
                "channels": [],
                "events": [],
            }
        ids = {row["id"] for row in runs}
        chosen = run_id or "eps204"
        if chosen not in ids:
            if run_id:
                raise HTTPException(404, f"unknown run {run_id}")
            chosen = runs[0]["id"]
        run = next(row for row in runs if row["id"] == chosen)
        channels = [
            _desk_channel(spec, name, [_row(item) for item in query_channel(conn, chosen, name)])
            for name in DESK_CHANNELS
            if name in spec["channels"]
        ]
        events = [_row(item) for item in query_events(conn, chosen)]
    last_t = max((ch.get("time_s") or 0) for ch in channels) if channels else None
    period_min = float(spec["constants"]["orbital_period_min"])
    period_s = period_min * 60.0
    solar = next((ch for ch in channels if ch["id"] == "EPS.solar_array_current"), None)
    solar_now = (solar or {}).get("value_num")
    return {
        "run_id": chosen,
        "scenario": run.get("scenario"),
        "notes": run.get("notes") or "",
        "clock": format_clock(last_t) if last_t is not None else None,
        "time_s": last_t,
        "scope": "Last sample on this tape. Not a live downlink.",
        "orbit": {
            "period_min": period_min,
            "eclipse_fraction": float(spec["constants"]["eclipse_fraction"]),
            "phase": ((last_t or 0) / period_s) % 1,
            "illumination": "sun" if (solar_now or 0) > 1 else "eclipse",
        },
        "channels": channels,
        "events": events,
    }


@app.get("/entry-alarms")
def entry_alarms() -> list[dict[str, Any]]:
    """Alarms an operator can open an incident from. ORBIT does not detect these."""
    return _entry_alarms(load_and_validate())


@app.get("/incidents")
def incidents() -> list[dict[str, Any]]:
    with _conn() as conn:
        ensure_demo_incident(conn)
        return [dict(row) for row in list_incidents(conn)]


@app.post("/incidents")
def open_incident(body: IncidentIn) -> dict[str, Any]:
    spec = load_and_validate()
    allowed = {item["id"] for item in _entry_alarms(spec)}
    if body.alarm not in allowed:
        raise HTTPException(400, f"{body.alarm} is not an entry alarm")
    try:
        with _conn() as conn:
            return create_incident(conn, body.run_id, body.alarm, body.title)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/incidents/{incident_id}")
def incident(incident_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        return dict(row)


@app.get("/incidents/{incident_id}/workspace")
def incident_workspace(incident_id: str) -> dict[str, Any]:
    spec = load_and_validate()
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        run_id = row["run_id"]
        needed = list(WORKSPACE_CHANNELS)
        if row["alarm"] not in needed:
            needed.append(row["alarm"])
        events = [_row(item) for item in query_events(conn, run_id)]
        telemetry = {
            channel: [_row(item) for item in query_channel(conn, run_id, channel)]
            for channel in needed
        }
        documents = [dict(item) for item in list_documents(conn)]
    data = workspace_payload(spec, run_id, events, telemetry, documents, extra_channels=[row["alarm"]])
    data["incident"] = dict(row)
    data["alarm"] = row["alarm"]
    return data


def workspace_payload(
    spec: dict[str, Any],
    run_id: str,
    events: list[dict[str, Any]],
    telemetry: dict[str, Any],
    documents: list[dict[str, Any]],
    extra_channels: list[str] | None = None,
) -> dict[str, Any]:
    names = list(WORKSPACE_CHANNELS)
    for name in extra_channels or []:
        if name not in names and name in spec["channels"]:
            names.append(name)
    return {
        "run_id": run_id,
        "scope": "assemble evidence and recommend a human decision. does not command the spacecraft.",
        "events": events,
        "telemetry": telemetry,
        "documents": documents,
        "channels": {name: _channel_card(spec, name) for name in names if name in spec["channels"]},
    }


@app.post("/incidents/{incident_id}/investigate")
def investigate_incident(incident_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        mark_incident_recommended(conn, incident_id)
        row = get_incident(conn, incident_id) or row
    report = investigate_rules(row["run_id"], alarm_channel=row["alarm"])
    return {
        "incident_id": incident_id,
        "run_id": row["run_id"],
        "provider": "rules",
        "alarm": row["alarm"],
        "status": row["status"],
        "report": report,
    }


class FileIn(BaseModel):
    note: str | None = Field(default=None)


@app.post("/incidents/{incident_id}/file")
def file_open_incident(incident_id: str, body: FileIn | None = None) -> dict[str, Any]:
    """Write a library close-out. Does not command the spacecraft."""
    note = (body.note if body else None) or None
    if note:
        note = note.strip() or None
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        if row["status"] == "filed":
            raise HTTPException(409, f"{incident_id} is already filed")
    report = investigate_rules(row["run_id"], alarm_channel=row["alarm"])
    closeout = build_closeout(dict(row), report, note)
    try:
        with _conn() as conn:
            filed = file_incident(conn, incident_id, closeout, operator_note=note)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "incident": filed,
        "document_id": filed["id"],
        "status": filed["status"],
    }


@app.get("/runs")
def runs() -> list[dict[str, Any]]:
    with _conn() as conn:
        return [_row(row) for row in list_runs(conn)]


@app.get("/runs/{run_id}/events")
def events(run_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = query_events(conn, run_id)
        if not rows and not any(r["id"] == run_id for r in list_runs(conn)):
            raise HTTPException(404, f"unknown run {run_id}")
        return [_row(row) for row in rows]


@app.get("/runs/{run_id}/workspace")
def workspace(run_id: str) -> dict[str, Any]:
    """One payload for the console: events, traces, channel limits, documents."""
    spec = load_and_validate()
    with _conn() as conn:
        if not any(row["id"] == run_id for row in list_runs(conn)):
            raise HTTPException(404, f"unknown run {run_id}")
        events = [_row(row) for row in query_events(conn, run_id)]
        telemetry = {
            channel: [_row(row) for row in query_channel(conn, run_id, channel)]
            for channel in WORKSPACE_CHANNELS
        }
        documents = [dict(row) for row in list_documents(conn)]
    return workspace_payload(spec, run_id, events, telemetry, documents)


@app.get("/runs/{run_id}/channels/{channel}")
def channel(
    run_id: str,
    channel: str,
    from_clock: str | None = Query(default=None),
    to_clock: str | None = Query(default=None),
) -> list[dict[str, Any]]:
    start = clock_to_s(from_clock) if from_clock else None
    end = clock_to_s(to_clock) if to_clock else None
    with _conn() as conn:
        rows = query_channel(conn, run_id, channel, start, end)
        if not rows and not any(r["id"] == run_id for r in list_runs(conn)):
            raise HTTPException(404, f"unknown run {run_id}")
        return [_row(row) for row in rows]


@app.get("/documents")
def documents() -> list[dict[str, Any]]:
    with _conn() as conn:
        return [dict(row) for row in list_documents(conn)]


@app.get("/documents/{doc_id}")
def document(doc_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_document(conn, doc_id)
        if row is None:
            raise HTTPException(404, f"unknown document {doc_id}")
        return {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "path": row["path"],
            "body": row["body"],
        }


@app.get("/search")
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=40),
) -> list[dict[str, Any]]:
    """Semantic library search. Local embeddings, not a paid model."""
    with _conn() as conn:
        return [_row(row) for row in search_documents(conn, q, limit=limit)]


@app.post("/investigate/{run_id}")
def investigate(run_id: str, alarm: str = Query(default="EPS.bus_voltage")) -> dict[str, str]:
    """Rules-based investigation only. Paid LLM stays on the CLI, on request."""
    report = investigate_rules(run_id, alarm_channel=alarm)
    return {"run_id": run_id, "provider": "rules", "alarm": alarm, "report": report}


@app.get("/")
def console() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


app.mount("/static", StaticFiles(directory=UI_DIR), name="static")
