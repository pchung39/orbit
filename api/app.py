"""ORBIT HTTP API. Read-only investigation workspace.

Does not command the spacecraft. Investigation uses --provider rules only
(no paid LLM). Same store the CLI uses. Serves the ops console at /.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent.closeout import build_closeout
from agent.hypothesis import hypothesis_for
from agent.investigate import investigate_rules
from agent.tools import Tools
from agent.tracing import flush_tracing, init_tracing, log_to_span, span
from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import load_and_validate
from storage.sources import (
    bind_preview,
    list_activity,
    list_archive_catalog,
    list_connectors,
    parse_alarm_clock,
    resolve_archive_run,
    seal_run_window,
    sync_connector,
)
from eval.bundle import PromoteError, promote_candidate_to_baseline
from eval.compare import run_compare
from eval.explorer import build_explorer_case_detail, build_explorer_index
from storage.store import (
    connect,
    create_incident,
    ensure_demo_incident,
    file_incident,
    get_document,
    get_hypothesis_feedback,
    get_incident,
    init_schema,
    list_documents,
    list_incidents,
    list_runs,
    save_investigation,
    query_channel,
    query_events,
    search_documents,
    store_trust_snapshot,
    upsert_hypothesis_feedback,
    _load_eval_baseline,
    _load_eval_candidate,
    _load_eval_comparison,
    _load_eval_scorecard,
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


@api.get("/trust")
def trust() -> dict[str, Any]:
    """Data-plane health for the trust console. Read-only."""
    spec = load_and_validate()
    with _conn() as conn:
        ensure_demo_incident(conn)
        snapshot = store_trust_snapshot(conn, spec)
    snapshot["boundaries"] = [
        "ORBIT replays ingested telemetry tapes — not a live downlink.",
        "ORBIT does not detect anomalies or open alarms on its own.",
        "ORBIT assembles tagged reports; it does not command the spacecraft.",
        "Report assembly may omit a root-cause hypothesis when no load meets the procedure bar.",
        "Investigation in this console uses rules only — no paid LLM.",
    ]
    return snapshot


class PromoteBaselineBody(BaseModel):
    note: str | None = None
    force: bool = False


@api.get("/eval/compare")
def eval_compare() -> dict[str, Any]:
    """Baseline vs candidate release comparison."""
    return run_compare(write=True)


@api.get("/eval/explorer")
def eval_explorer() -> dict[str, Any]:
    """Eval Explorer index — cases, metrics, and run metadata."""
    candidate = _load_eval_candidate()
    if not candidate:
        raise HTTPException(404, "no candidate run — run python -m eval")
    comparison = _load_eval_comparison()
    if comparison is None and _load_eval_baseline():
        comparison = run_compare(write=False)
    scorecard = _load_eval_scorecard()
    return build_explorer_index(candidate, comparison, scorecard)


@api.get("/eval/baseline")
def eval_baseline() -> dict[str, Any]:
    data = _load_eval_baseline()
    if not data:
        raise HTTPException(404, "no approved baseline — promote a passing candidate first")
    return {
        "baseline_id": data.get("baseline_id"),
        "approved_at": data.get("approved_at"),
        "generated_at": data.get("generated_at"),
        "agent": data.get("agent"),
        "scorecard": data.get("scorecard"),
        "suite_case_ids": data.get("suite_case_ids"),
        "note": data.get("note"),
    }


@api.get("/eval/candidate")
def eval_candidate() -> dict[str, Any]:
    data = _load_eval_candidate()
    if not data:
        raise HTTPException(404, "no candidate run — run python -m eval")
    return {
        "run_id": data.get("run_id"),
        "generated_at": data.get("generated_at"),
        "agent": data.get("agent"),
        "scorecard": data.get("scorecard"),
        "suite_case_ids": data.get("suite_case_ids"),
        "cases": [
            {
                "id": case_id,
                "ok": entry.get("ok"),
                "passed": entry.get("passed"),
                "total": entry.get("total"),
                "label": (entry.get("contract") or {}).get("label"),
            }
            for case_id, entry in sorted((data.get("cases") or {}).items())
        ],
    }


@api.get("/eval/cases/{case_id}")
def eval_case_detail(case_id: str) -> dict[str, Any]:
    data = _load_eval_candidate()
    if not data:
        raise HTTPException(404, "no candidate run — run python -m eval")
    cases = data.get("cases") or {}
    if case_id not in cases:
        raise HTTPException(404, f"unknown eval case {case_id}")
    entry = cases[case_id]
    baseline = _load_eval_baseline()
    baseline_entry = (baseline.get("cases") or {}).get(case_id) if baseline else None
    comparison = _load_eval_comparison()
    if comparison is None and baseline:
        comparison = run_compare(write=False)
    explorer = build_explorer_case_detail(
        case_id,
        entry,
        baseline_entry,
        comparison,
        baseline,
    )
    return {
        "id": case_id,
        "candidate": entry,
        "baseline": baseline_entry,
        **explorer,
    }


@api.post("/eval/baseline/promote")
def eval_promote_baseline(body: PromoteBaselineBody) -> dict[str, Any]:
    try:
        path = promote_candidate_to_baseline(note=body.note, force=body.force)
        run_compare(write=True)
        return {"ok": True, "path": str(path), "baseline": _load_eval_baseline()}
    except PromoteError as exc:
        raise HTTPException(409, str(exc)) from exc


@api.get("/desk")
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


@api.get("/entry-alarms")
def entry_alarms() -> list[dict[str, Any]]:
    """Alarms an operator can open an incident from. ORBIT does not detect these."""
    return _entry_alarms(load_and_validate())


@api.get("/incidents")
def incidents() -> list[dict[str, Any]]:
    with _conn() as conn:
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
            return create_incident(conn, sealed_run_id, body.alarm, body.title, notes=notes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@api.get("/sources")
def sources() -> dict[str, Any]:
    """Upstream archive catalog + library index. Cases fetch-on-seal — not a live feed."""
    with _conn() as conn:
        ensure_demo_incident(conn)
        connectors = list_connectors(conn)
    return {
        "adapters": "demo-local",
        "note": (
            "Mission archive stays upstream. Opening a case fetches a time window and stores "
            "only the sealed package in ORBIT. Library rebuilds the search index on demand. "
            "ORBIT does not detect or command."
        ),
        "connectors": connectors,
        "activity": list_activity(),
    }


@api.get("/archive")
def archive_catalog() -> list[dict[str, Any]]:
    """Upstream archive tapes available to seal from (metadata + reachability)."""
    return list_archive_catalog()


@api.get("/sources/activity")
def sources_activity(limit: int = Query(default=20, ge=1, le=50)) -> list[dict[str, Any]]:
    return list_activity(limit)


@api.post("/sources/{connector_id}/sync")
def sources_sync(connector_id: str) -> dict[str, Any]:
    try:
        with _conn() as conn:
            ensure_demo_incident(conn)
            connector = sync_connector(conn, connector_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {
        "connector": connector,
        "activity": list_activity(),
    }

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
        events = [_row(item) for item in query_events(conn, run_id)]
        telemetry = {
            channel: [_row(item) for item in query_channel(conn, run_id, channel)]
            for channel in needed
        }
        documents = [dict(item) for item in list_documents(conn)]
        fb = get_hypothesis_feedback(conn, incident_id)
    data = workspace_payload(spec, run_id, events, telemetry, documents, extra_channels=[row["alarm"]])
    data["incident"] = dict(row)
    if fb:
        data["incident"]["feedback"] = dict(fb)
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


@api.post("/incidents/{incident_id}/investigate")
def investigate_incident(incident_id: str) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        if row["status"] == "filed":
            raise HTTPException(409, f"{incident_id} is already filed")
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
        }
        log_to_span(sp, output={"incident_id": incident_id, "run_id": row["run_id"], "chars": len(report)})
        return out


class FileIn(BaseModel):
    note: str | None = Field(default=None)


class FeedbackIn(BaseModel):
    verdict: str = Field(pattern="^(confirmed|rejected)$")
    note: str | None = Field(default=None)


@api.get("/incidents/{incident_id}/feedback")
def incident_feedback(incident_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        fb = get_hypothesis_feedback(conn, incident_id)
        return dict(fb) if fb else None


@api.put("/incidents/{incident_id}/feedback")
def save_incident_feedback(incident_id: str, body: FeedbackIn) -> dict[str, Any]:
    with _conn() as conn:
        row = get_incident(conn, incident_id)
        if row is None:
            raise HTTPException(404, f"unknown incident {incident_id}")
        if row["status"] == "filed":
            raise HTTPException(409, f"{incident_id} is already filed")
    hyp = hypothesis_for(row["run_id"], row["alarm"])
    try:
        with _conn() as conn:
            fb = upsert_hypothesis_feedback(
                conn,
                incident_id,
                run_id=row["run_id"],
                alarm=row["alarm"],
                hypothesis_key=hyp.key,
                hypothesis_label=hyp.label,
                verdict=body.verdict,
                note=body.note,
            )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"feedback": fb, "incident_id": incident_id, "status": row["status"]}


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
        "incident": filed,
        "document_id": filed["id"],
        "status": filed["status"],
    }


@api.get("/runs")
def runs() -> list[dict[str, Any]]:
    with _conn() as conn:
        return [_row(row) for row in list_runs(conn)]


@api.get("/runs/{run_id}/events")
def events(run_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = query_events(conn, run_id)
        if not rows and not any(r["id"] == run_id for r in list_runs(conn)):
            raise HTTPException(404, f"unknown run {run_id}")
        return [_row(row) for row in rows]


@api.get("/runs/{run_id}/workspace")
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


@api.get("/runs/{run_id}/channels/{channel}")
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
        if not any(row["id"] == run_id for row in list_runs(conn)):
            raise HTTPException(404, f"unknown run {run_id}")
        tools = Tools(conn, spec)
        crossing_row = tools.first_warn(run_id, alarm_ch)
        pin_s = clock_to_s(pin_clock) if pin_clock else None

        all_rows = query_channel(conn, run_id, channel)
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

        samples = [_row(row) for row in query_channel(conn, run_id, channel, start_s, end_s)]
        events = [
            _row(row)
            for row in query_events(conn, run_id)
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
        "scope": "Ingested telemetry replay. ORBIT does not downlink or detect.",
    }


@api.get("/documents")
def documents() -> list[dict[str, Any]]:
    with _conn() as conn:
        return [dict(row) for row in list_documents(conn)]


@api.get("/documents/{doc_id}")
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


@api.get("/search")
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=40),
) -> list[dict[str, Any]]:
    """Semantic library search. Local embeddings, not a paid model."""
    with _conn() as conn:
        return [_row(row) for row in search_documents(conn, q, limit=limit)]


@api.post("/investigate/{run_id}")
def investigate(run_id: str, alarm: str = Query(default="EPS.bus_voltage")) -> dict[str, str]:
    """Rules-based investigation only. Paid LLM stays on the CLI, on request."""
    with span(
        "api.investigate_run",
        span_type="task",
        input={"run_id": run_id, "alarm": alarm},
        metadata={"provider": "rules", "source": "api"},
    ) as sp:
        report = investigate_rules(run_id, alarm_channel=alarm)
        log_to_span(sp, output={"run_id": run_id, "chars": len(report)})
        return {"run_id": run_id, "provider": "rules", "alarm": alarm, "report": report}


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
    return FileResponse(UI_DIR / "landing.html")


app.include_router(api)
# Mount before SPA catch-all so /static/* is not swallowed.
app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


@app.get("/")
def marketing_home() -> FileResponse:
    return _landing()


@app.get("/app")
@app.get("/app/")
def spa_home() -> FileResponse:
    return _spa_index()


@app.get("/app/incidents")
def spa_incidents() -> FileResponse:
    return _spa_index()


@app.get("/app/trust")
def spa_trust() -> FileResponse:
    return _spa_index()


@app.get("/app/incidents/{incident_id}")
def spa_case(incident_id: str) -> FileResponse:
    return _spa_index()


# Legacy console paths → /app (bookmarks + old links).
@app.get("/incidents")
def legacy_incidents() -> RedirectResponse:
    return RedirectResponse(url="/app/incidents", status_code=307)


@app.get("/trust")
def legacy_trust() -> RedirectResponse:
    return RedirectResponse(url="/app/trust", status_code=307)


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
