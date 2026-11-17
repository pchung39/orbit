"""ORBIT HTTP API. Read-only investigation workspace.

Does not command the spacecraft. Investigation uses --provider rules only
(no paid LLM). Same store the CLI uses. Serves the ops console at /.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent.brief import build_brief
from agent.closeout import build_closeout
from agent.hypothesis import HYPOTHESIS_BY_FAMILY
from agent.investigate import investigate_rules
from agent.tools import Tools
from agent.tracing import flush_tracing, init_tracing, log_to_span, span
from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import load_and_validate
from storage.sources import (
    bind_preview,
    list_archive_catalog,
    parse_alarm_clock,
    resolve_archive_run,
    seal_run_window,
)
from storage.evidence import list_runs, query_channel, query_events
from storage.store import (
    connect,
    create_incident,
    decide_incident,
    ensure_demo_incident,
    file_incident,
    get_hypothesis_feedback,
    get_incident,
    init_schema,
    list_incidents,
    reset_demo_incidents,
    save_investigation,
    upsert_hypothesis_feedback,
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
    "PAY.payload_current": "Payload current",
    "EPS.battery_voltage": "Battery voltage",
    "EPS.solar_array_current": "Solar array",
}

INSPECT_CHANNELS = WORKSPACE_CHANNELS
INSPECT_FOCUS_PAD_S = 8 * 60

class IncidentIn(BaseModel):
    alarm: str
    alarm_time: str | None = Field(default=None)
    title: str | None = Field(default=None)
    # Archive source run to seal from (not the final sealed run_id).
    run_id: str | None = Field(default=None)


def _entry_alarms(spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for name, meta in spec["channels"].items():
        if meta.get("warn_limit") is None:
            continue
        item = {
            "id": name,
            "unit": meta.get("unit"),
            "warn_limit": meta.get("warn_limit"),
            "physical_meaning": meta.get("physical_meaning"),
        }
        preview = bind_preview(name)
        if preview:
            item["bind"] = preview
        out.append(item)
    return out


TAPE_TITLES = {
    "eps204": "Heater + confounder",
    "marg001": "Marginal loads",
    "fault1": "Heater only",
    "pay002": "Payload spike",
    "batt003": "Pack IR sag",
    "nominal": "Science pass",
}

ALARM_TITLES = {
    "EPS.bus_voltage": "Bus voltage",
    "PAY.payload_current": "Payload current",
    "EPS.battery_voltage": "Battery voltage",
}


def _source_run_id(run_id: str) -> str:
    if not run_id.startswith("sealed_"):
        return run_id
    rest = run_id[len("sealed_") :]
    for key in sorted(TAPE_TITLES, key=len, reverse=True):
        if rest.startswith(f"{key}_"):
            return key
    parts = rest.split("_")
    if len(parts) >= 3:
        return "_".join(parts[:-2]) or run_id
    return parts[0] if parts else run_id


def default_incident_title(alarm: str, run_id: str, alarm_time: str | None = None) -> str:
    alarm_label = ALARM_TITLES.get(alarm, alarm.split(".")[-1] if alarm else "Case")
    source = _source_run_id(run_id)
    tape = TAPE_TITLES.get(source)
    base = f"{tape} · {alarm_label}" if tape else alarm_label
    clock = (alarm_time or "").strip()
    if clock:
        return f"{base} · {clock}"
    if tape:
        return base
    return f"{alarm_label} · {run_id}"


app = FastAPI(
    title="ORBIT",
    description="Assemble telemetry, commands, procedures, and incidents. Does not command the spacecraft.",
)

api = APIRouter(prefix="/api")

init_tracing()


@app.on_event("shutdown")
def _flush_tracing() -> None:
    flush_tracing()


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


@api.get("/desk")
def desk(run_id: str | None = Query(default=None)) -> dict[str, Any]:
    """Last samples on a tape. Not a live downlink. ORBIT does not detect."""
    spec = load_and_validate()
    with _conn() as conn:
        ensure_demo_incident(conn)
        runs = list_runs()
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
            _desk_channel(spec, name, [_row(item) for item in query_channel(chosen, name)])
            for name in DESK_CHANNELS
            if name in spec["channels"]
        ]
        events = [_row(item) for item in query_events(chosen)]
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


@api.get("/entry-alarms")
def entry_alarms() -> list[dict[str, Any]]:
    """Alarms an operator can open an incident from. ORBIT does not detect these."""
    return _entry_alarms(load_and_validate())


@api.get("/incidents")
def incidents(fresh: bool = Query(default=False)) -> list[dict[str, Any]]:
    with _conn() as conn:
        if fresh:
            reset_demo_incidents(conn)
        else:
            ensure_demo_incident(conn)
        return [dict(row) for row in list_incidents(conn)]


@api.post("/incidents")
def open_incident(body: IncidentIn) -> dict[str, Any]:
    spec = load_and_validate()
    allowed = {item["id"] for item in _entry_alarms(spec)}
    if body.alarm not in allowed:
        raise HTTPException(400, f"{body.alarm} is not an entry alarm")
    clock = parse_alarm_clock(body.alarm_time)
    try:
        with _conn() as conn:
            source_run_id, _label = resolve_archive_run(conn, body.alarm, body.run_id)
            sealed_run_id, notes = seal_run_window(conn, source_run_id, body.alarm, clock)
            title = (body.title or "").strip() or default_incident_title(body.alarm, sealed_run_id, clock)
            return create_incident(conn, sealed_run_id, body.alarm, title, notes=notes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@api.get("/history/alarms")
def history_alarms() -> dict[str, Any]:
    """Alarm episodes found in the connected history, and any case already opened on each."""
    from storage.alarms import find_episodes
    from storage.connectors import active_config

    cfg = active_config()
    return {"source": cfg.name, "kind": cfg.kind, "episodes": find_episodes()}


class HistoryOpenIn(BaseModel):
    key: str


@api.post("/history/alarms/open")
def open_history_alarm(body: HistoryOpenIn) -> dict[str, Any]:
    """Seal the window around a history alarm straight from the source and open a case on it."""
    from storage.alarms import episode_title, find_episodes, seal_episode

    existing = next((e["case"] for e in find_episodes() if e["key"] == body.key and e["case"]), None)
    if existing:
        raise HTTPException(409, f"{existing} is already open on this alarm")
    try:
        sealed_id, notes, episode = seal_episode(body.key)
        with _conn() as conn:
            return create_incident(conn, sealed_id, episode["primary"]["channel"], episode_title(episode), notes=notes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@api.get("/archive")
def archive_catalog() -> list[dict[str, Any]]:
    """Upstream archive tapes available to seal from (metadata + reachability)."""
    return list_archive_catalog()


@api.get("/incidents/{incident_id}")
def incident(incident_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        out = dict(row)
        fb = get_hypothesis_feedback(conn, incident_id)
        if fb:
            out["feedback"] = dict(fb)
        return out


@api.get("/incidents/{incident_id}/workspace")
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
        events = [_row(item) for item in query_events(run_id)]
        telemetry = {
            channel: [_row(item) for item in query_channel(run_id, channel)]
            for channel in needed
        }
        fb = get_hypothesis_feedback(conn, incident_id)
    data = workspace_payload(spec, run_id, events, telemetry, extra_channels=[row["alarm"]])
    data["incident"] = _incident_out(row)
    if fb:
        data["incident"]["feedback"] = dict(fb)
    data["alarm"] = row["alarm"]
    # The brief exists once ORBIT has investigated; before that the page shows raw evidence only.
    data["brief"] = _brief_for(row) if row.get("investigation_report") else None
    return data


def _incident_out(row: Any) -> dict[str, Any]:
    out = dict(row)
    raw = out.get("verify_result")
    if isinstance(raw, str):
        try:
            out["verify_result"] = json.loads(raw)
        except ValueError:
            out["verify_result"] = None
    return out


def _brief_for(row: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return build_brief(row["run_id"], row["alarm"])
    except Exception as exc:  # a broken brief must not take the case page down
        return {"error": str(exc)}


@api.get("/incidents/{incident_id}/brief")
def incident_brief(incident_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
    if row is None:
        raise HTTPException(404, f"unknown incident {incident_id}")
    return _brief_for(dict(row)) if row.get("investigation_report") else None


def workspace_payload(
    spec: dict[str, Any],
    run_id: str,
    events: list[dict[str, Any]],
    telemetry: dict[str, Any],
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
        "channels": {name: _channel_card(spec, name) for name in names if name in spec["channels"]},
    }


@api.post("/incidents/{incident_id}/investigate")
def investigate_incident(incident_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
    with span(
        "api.investigate_incident",
        span_type="task",
        input={"incident_id": incident_id, "run_id": row["run_id"], "alarm": row["alarm"]},
        metadata={"provider": "rules", "source": "console"},
    ) as sp:
        report = investigate_rules(row["run_id"], alarm_channel=row["alarm"])
        try:
            with _conn() as conn:
                saved = save_investigation(conn, incident_id, report)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if saved is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        out = {
            "incident_id": incident_id,
            "run_id": saved["run_id"],
            "provider": "rules",
            "alarm": saved["alarm"],
            "status": saved["status"],
            "report": report,
            "investigated_at": saved.get("investigated_at"),
            "brief": _brief_for(dict(saved)),
        }
        log_to_span(sp, output={"incident_id": incident_id, "run_id": row["run_id"], "chars": len(report)})
        return out


class FileIn(BaseModel):
    note: str | None = Field(default=None)


class DecideIn(BaseModel):
    option: str = Field(pattern="^(heater_off|payload_safe|hold)$")
    note: str | None = Field(default=None)


VERIFY_STEP = {
    ("heater_off", True): "EPS-17 step 7: the bus recovered, so leave Heater B off and open a fault report.",
    ("payload_safe", True): "PAY-04 step 7: current recovered, so leave the payload in STANDBY and open a fault report.",
    ("heater_off", False): "No recovery. EPS-17 step 7: check the next suspect load or continue to EPS-09.",
    ("payload_safe", False): "No recovery. Return to the evidence and pick the next suspect.",
}
WATCH_STEP = {
    "withheld": "Watching. EPS-17 step 4 is not met; reopen if Heater B current reaches the 2× bar.",
    "battery": "Watching. EPS-09 step 7: continue the battery checkout offline.",
}


@api.post("/incidents/{incident_id}/decide")
def decide(incident_id: str, body: DecideIn) -> dict[str, Any]:
    """Record the operator's decision and run it in the simulator. Nothing is uplinked."""
    with _conn() as conn:
        row = get_incident(conn, incident_id)
    if row is None:
        raise HTTPException(404, f"unknown incident {incident_id}")
    if not row.get("investigation_report"):
        raise HTTPException(409, f"{incident_id} has not been investigated")
    brief = _brief_for(dict(row)) or {}
    simulation = brief.get("simulation")
    option = next((o for o in (simulation or {}).get("decision", {}).get("options", []) if o["id"] == body.option), None)
    family = brief.get("family", "open")
    if option is None:
        verify = {"option": body.option, "simulated": False, "label": body.option,
                  "text": "No simulator recipe for this tape. The decision is recorded without a preview."}
    else:
        clears = option["result"] == "clears"
        borderline = option["result"] == "borderline"
        step = (
            WATCH_STEP.get(family, "Watching. Hold until the evidence clears a procedure bar.")
            if body.option == "hold"
            else "Too close to call in the forecast. After commanding, watch the alarm channel against the warn."
            if borderline
            else VERIFY_STEP[(body.option, clears)]
        )
        verify = {
            "option": body.option,
            "label": option["label"],
            "simulated": True,
            "recommended": option["recommended"],
            "result": option["result"],
            "clears": clears,
            "text": option["text"],
            "step": step,
            "decision_clock": simulation["decision"]["clock"],
            "channel": simulation["channel"],
            "unit": simulation["unit"],
            "outcome": option["outcome"],
        }
    hyp_key, hyp_label = HYPOTHESIS_BY_FAMILY.get(family, ("OPEN", "No hypothesis"))
    recommended = (option or {}).get("recommended", False)
    try:
        with _conn() as conn:
            saved = decide_incident(conn, incident_id, option=body.option, note=body.note, verify_result=verify)
            upsert_hypothesis_feedback(
                conn,
                incident_id,
                run_id=row["run_id"],
                alarm=row["alarm"],
                hypothesis_key=hyp_key,
                hypothesis_label=hyp_label,
                verdict="confirmed" if recommended else "rejected",
                note=body.note,
            )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"incident": _incident_out(saved), "status": saved["status"], "verify_result": verify}


@api.post("/incidents/{incident_id}/file")
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
        report = row.get("investigation_report")
        if not report:
            report = investigate_rules(row["run_id"], alarm_channel=row["alarm"])
    with _conn() as conn:
        feedback = get_hypothesis_feedback(conn, incident_id)
    closeout = build_closeout(dict(row), report, note, feedback=dict(feedback) if feedback else None)
    try:
        with _conn() as conn:
            filed = file_incident(conn, incident_id, closeout, operator_note=note)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "incident": _incident_out(filed),
        "status": filed["status"],
    }


@api.get("/sources")
def sources() -> dict[str, Any]:
    """Connected history and the power model learned from it."""
    from model.eps import PARAM_LABELS, datasheet, model_report
    from storage.archive_seed import DEMO_URL, demo_ready
    from storage.history import source_summary

    history = source_summary()
    report = model_report()
    return {
        "history": history,
        "model": report,
        # Models learned before sources were tracked came from the built-in dummy CSV.
        "model_stale": bool(report and report.get("source_stamp", "csv:builtin") != history["stamp"]),
        "prior": datasheet().params,
        "param_labels": {k: {"label": v[0], "unit": v[1]} for k, v in PARAM_LABELS.items()},
        "demo_db": {"url": DEMO_URL, "ready": demo_ready()},
    }


class ProbeIn(BaseModel):
    kind: str = Field(pattern="^(postgres|csv)$")
    url: str | None = None
    table: str | None = None
    layout: str | None = None
    time_col: str | None = None
    channel_col: str | None = None
    value_col: str | None = None
    text_col: str | None = None
    command_col: str | None = None


def _csv_path(role: str) -> str:
    from storage.connectors import UPLOAD_DIR

    path = UPLOAD_DIR / f"{role}.csv"
    if not path.exists():
        raise HTTPException(400, f"upload a {role} CSV first")
    return str(path)


@api.post("/sources/test")
def sources_test(body: ProbeIn) -> dict[str, Any]:
    from storage.connectors import pg_test

    if not body.url:
        raise HTTPException(400, "url required")
    return pg_test(body.url)


@api.post("/sources/inspect")
def sources_inspect(body: ProbeIn) -> dict[str, Any]:
    from storage.connectors import pg_inspect

    if body.kind != "postgres" or not body.url or not body.table:
        raise HTTPException(400, "postgres url and table required")
    try:
        return pg_inspect(body.url, body.table)
    except Exception as exc:
        raise HTTPException(400, str(exc).splitlines()[0]) from exc


@api.post("/sources/channels")
def sources_channels(body: ProbeIn) -> dict[str, Any]:
    """Every channel in the chosen table with its value range, and ORBIT's suggested mapping."""
    from storage.connectors import csv_channel_stats, pg_channel_stats, suggest_channels

    try:
        if body.kind == "postgres":
            stats = pg_channel_stats(body.url, body.table, body.layout, body.time_col,
                                     body.channel_col, body.value_col, body.text_col)
        else:
            stats = csv_channel_stats(_csv_path("telemetry"), body.layout, body.time_col,
                                      body.channel_col, body.value_col, body.text_col)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, str(exc).splitlines()[0]) from exc
    return {"stats": stats, "suggestions": suggest_channels(stats)}


@api.post("/sources/commands")
def sources_commands(body: ProbeIn) -> dict[str, Any]:
    from storage.connectors import ORBIT_COMMANDS, csv_command_names, pg_command_names, suggest_commands

    try:
        if body.kind == "postgres":
            names = pg_command_names(body.url, body.table, body.command_col)
        else:
            names = csv_command_names(_csv_path("commands"), body.command_col)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, str(exc).splitlines()[0]) from exc
    return {"commands": suggest_commands(names), "orbit_commands": ORBIT_COMMANDS}


@api.post("/sources/upload")
async def sources_upload(request: Request, role: str = Query(pattern="^(telemetry|commands)$")) -> dict[str, Any]:
    """CSV fallback: the browser sends the file as the request body."""
    from storage.connectors import save_upload

    body = await request.body()
    if not body:
        raise HTTPException(400, "empty file")
    try:
        return save_upload(role, body)
    except Exception as exc:
        raise HTTPException(400, f"couldn't read that CSV: {str(exc).splitlines()[0]}") from exc


class SaveSourceIn(BaseModel):
    kind: str = Field(pattern="^(postgres|csv)$")
    name: str
    url: str | None = None
    layout: str
    table: str | None = None
    time_col: str
    channel_col: str | None = None
    value_col: str | None = None
    text_col: str | None = None
    channels: dict[str, dict[str, Any]]
    commands: dict[str, Any] = Field(default_factory=dict)
    synthetic: bool = False


@api.post("/sources/save")
def sources_save(body: SaveSourceIn) -> dict[str, Any]:
    """Make this the active history source. The model is not re-learned until asked."""
    from storage.connectors import SourceConfig, load_history, save_config
    from storage.history import source_summary

    files = {}
    if body.kind == "csv":
        files = {"telemetry": _csv_path("telemetry")}
        if body.commands.get("command_col"):
            files["commands"] = _csv_path("commands")
    cfg = SourceConfig(**body.model_dump(), files=files)
    try:
        load_history(cfg)  # fail now, not later, if the mapping can't be read
    except Exception as exc:
        raise HTTPException(400, f"couldn't load history with that mapping: {str(exc).splitlines()[0]}") from exc
    save_config(cfg)
    return {"history": source_summary()}


@api.post("/sources/reset")
def sources_reset() -> dict[str, Any]:
    from storage.connectors import reset_to_dummy
    from storage.history import source_summary

    reset_to_dummy()
    return {"history": source_summary()}


@api.post("/model/calibrate")
def calibrate_model() -> dict[str, Any]:
    """Re-learn the power model from history. Takes a few seconds; nothing leaves this machine."""
    from model.eps import calibrate

    return {"model": calibrate()}


@api.get("/runs")
def runs() -> list[dict[str, Any]]:
    return [_row(row) for row in list_runs()]


@api.get("/runs/{run_id}/inspect")
def inspect_tape(
    run_id: str,
    channel: str = Query(..., description="Telemetry channel to list sample-by-sample"),
    alarm: str | None = Query(default=None, description="Alarm channel for first-warn anchor"),
    window: str = Query(default="focus", pattern="^(focus|full)$"),
    pin_clock: str | None = Query(default=None),
) -> dict[str, Any]:
    """Scoped sample table + events for human verification. Not raw SQL."""
    spec = load_and_validate()
    if channel not in spec["channels"]:
        raise HTTPException(400, f"unknown channel {channel}")
    alarm_ch = alarm if alarm and alarm in spec["channels"] else channel
    with _conn() as conn:
        if not any(row["id"] == run_id for row in list_runs()):
            raise HTTPException(404, f"unknown run {run_id}")
        tools = Tools(conn, spec)
        crossing_row = tools.first_warn(run_id, alarm_ch)
        pin_s = clock_to_s(pin_clock) if pin_clock else None

        all_rows = query_channel(run_id, channel)
        if not all_rows:
            raise HTTPException(404, f"no telemetry for {run_id} {channel}")
        t0_full = float(all_rows[0]["time_s"])
        t1_full = float(all_rows[-1]["time_s"])

        anchor = pin_s
        if anchor is None and crossing_row is not None:
            anchor = float(crossing_row["time_s"])
        if anchor is None:
            anchor = t1_full

        if window == "full":
            start_s, end_s = t0_full, t1_full
        else:
            start_s = max(t0_full, anchor - INSPECT_FOCUS_PAD_S)
            end_s = min(t1_full, anchor + INSPECT_FOCUS_PAD_S)

        samples = [_row(row) for row in query_channel(run_id, channel, start_s, end_s)]
        events = [
            _row(row)
            for row in query_events(run_id)
            if start_s <= float(row["time_s"]) <= end_s
        ]

        crossing = None
        if crossing_row is not None:
            c = _row(crossing_row)
            crossing = {
                "channel": alarm_ch,
                "clock": c["clock"],
                "time_s": c["time_s"],
                "value_num": c.get("value_num"),
                "value_text": c.get("value_text"),
            }

        pin = None
        if pin_s is not None:
            pin = {"time_s": pin_s, "clock": format_clock(pin_s)}

        channel_options = [
            {
                "id": name,
                "title": DESK_TITLES.get(name, name),
                "subsystem": spec["channels"][name].get("subsystem"),
                "unit": spec["channels"][name].get("unit"),
            }
            for name in INSPECT_CHANNELS
            if name in spec["channels"]
        ]

    return {
        "run_id": run_id,
        "channel": channel,
        "alarm": alarm_ch,
        "window": window,
        "from_clock": format_clock(start_s),
        "to_clock": format_clock(end_s),
        "from_time_s": start_s,
        "to_time_s": end_s,
        "sample_count": len(samples),
        "crossing": crossing,
        "pin": pin,
        "samples": samples,
        "events": events,
        "channels": channel_options,
        "scope": "Tape file replay. ORBIT does not downlink or detect.",
    }


def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/health")
def health_root() -> dict[str, bool]:
    return health()


@api.get("/health")
def health_api() -> dict[str, bool]:
    return health()


def _spa_index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


def _landing() -> FileResponse:
    return FileResponse(UI_DIR / "landing-v2.html")


app.include_router(api)
# Mount before SPA catch-all so /static/* is not swallowed.
app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


def _about() -> FileResponse:
    return FileResponse(UI_DIR / "about.html")


@app.get("/")
def marketing_home() -> FileResponse:
    return _landing()


@app.get("/about")
def about_orbit() -> FileResponse:
    return _about()


@app.get("/app")
@app.get("/app/")
def spa_home() -> FileResponse:
    return _spa_index()


@app.get("/app/incidents")
def spa_incidents() -> FileResponse:
    return _spa_index()


@app.get("/app/incidents/{incident_id}")
def spa_case(incident_id: str) -> FileResponse:
    return _spa_index()


# Legacy console paths → /app (bookmarks + old links).
@app.get("/incidents")
def legacy_incidents() -> RedirectResponse:
    return RedirectResponse(url="/app/incidents", status_code=307)


@app.get("/incidents/{incident_id}")
def legacy_case(incident_id: str) -> RedirectResponse:
    return RedirectResponse(url=f"/app/incidents/{incident_id}", status_code=307)


@app.get("/{full_path:path}")
def spa_fallback(full_path: str) -> FileResponse:
    """SPA fallback under /app/*. Do not swallow /api or /static."""
    if full_path == "api" or full_path.startswith("api/") or full_path.startswith("static/"):
        raise HTTPException(404, "Not found")
    if full_path == "app" or full_path.startswith("app/"):
        if "." in full_path.rsplit("/", 1)[-1]:
            raise HTTPException(404, "Not found")
        return _spa_index()
    if "." in full_path.rsplit("/", 1)[-1]:
        raise HTTPException(404, "Not found")
    raise HTTPException(404, "Not found")
