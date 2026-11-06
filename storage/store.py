"""Case log: incidents and operator feedback.

Postgres via Docker Compose. Local demo credentials live in docker-compose.yml
(orbit/orbit) — not a production secret. Tapes, sealed windows, and procedure
files are read from disk. This is not the agent.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from simulator.scenarios import (
    clock_to_s,
    format_clock,
    run_batt003,
    run_eps204,
    run_inc0162,
    run_inc0187,
    run_inc0191,
    run_marg001,
    run_nominal_slice,
    run_pay002,
)
from simulator.simulate import SPEC_PATH, load_and_validate

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"
DEFAULT_URL = "postgresql://orbit:orbit@localhost:5432/orbit"


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or os.environ.get("DATABASE_URL", DEFAULT_URL), row_factory=dict_row)


def _column_exists(conn: psycopg.Connection, table: str, column: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = %s AND column_name = %s",
        (table, column),
    ).fetchone()
    return row is not None


def _skip_redundant_alter(conn: psycopg.Connection, stmt: str) -> bool:
    """Avoid ACCESS EXCLUSIVE locks from ADD COLUMN IF NOT EXISTS on every request."""
    text = " ".join(stmt.split())
    prefix = "ALTER TABLE "
    marker = " ADD COLUMN IF NOT EXISTS "
    if not text.upper().startswith(prefix) or marker not in text.upper():
        return False
    # Preserve original casing for names; split on the known schema shape.
    head, rest = text.split(" ADD COLUMN IF NOT EXISTS ", 1)
    table = head.split()[-1]
    column = rest.split()[0]
    return _column_exists(conn, table, column)


def init_schema(conn: psycopg.Connection) -> None:
    """Create the case log and drop leftover archive tables from older builds."""
    conn.execute("ALTER TABLE IF EXISTS incidents DROP CONSTRAINT IF EXISTS incidents_run_id_fkey")
    conn.execute("DROP TABLE IF EXISTS telemetry")
    conn.execute("DROP TABLE IF EXISTS events")
    conn.execute("DROP TABLE IF EXISTS documents")
    conn.execute("DROP TABLE IF EXISTS runs")
    conn.commit()
    try:
        conn.execute("DROP EXTENSION IF EXISTS vector")
        conn.commit()
    except Exception:
        conn.rollback()
    for stmt in SCHEMA_PATH.read_text().split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        if _skip_redundant_alter(conn, stmt):
            continue
        conn.execute(stmt)
    conn.commit()



def events_for_run(spec: dict[str, Any], run_id: str) -> list[tuple[float, str, str, str]]:
    if run_id in ("eps204", "fault1", "marg001"):
        out: list[tuple[float, str, str, str]] = []
        for event in spec["demo_scenario_EPS204"]["script"]:
            if event["event"] not in ("command", "mode_change"):
                continue
            if run_id == "fault1" and event["action"] == "SCIENCE_MODE":
                continue
            out.append(
                (clock_to_s(event["t"]), event["event"], event["channel"], event["action"])
            )
        return out
    catalog = {
        "inc0187": [(clock_to_s("01:52:00"), "command", "THM.heater_b_current", "HEATER_B_ENABLE")],
        "pay002": [(clock_to_s("10:12:00"), "mode_change", "PAY.mode", "SCIENCE_MODE")],
        "inc0191": [(clock_to_s("08:14:00"), "mode_change", "PAY.mode", "SCIENCE_MODE")],
        "batt003": [(clock_to_s("00:10:00"), "command", "THM.heater_b_current", "HEATER_B_ENABLE")],
        "inc0162": [(clock_to_s("00:18:00"), "command", "THM.heater_b_current", "HEATER_B_ENABLE")],
        "nominal": [(clock_to_s("12:10:00"), "mode_change", "PAY.mode", "SCIENCE_MODE")],
    }
    return list(catalog.get(run_id, []))


_INCIDENT_COLS = (
    "id, title, run_id, alarm, status, opened_at, notes, filed_at, closeout, "
    "investigation_report, investigated_at"
)
_INCIDENT_LIST_COLS = (
    "id, title, run_id, alarm, status, opened_at, notes, filed_at"
)


def list_incidents(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return list(
        conn.execute(
            f"SELECT {_INCIDENT_LIST_COLS} FROM incidents ORDER BY opened_at DESC, id DESC"
        ).fetchall()
    )


def get_incident(conn: psycopg.Connection, incident_id: str) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {_INCIDENT_COLS} FROM incidents WHERE id = %s",
        (incident_id,),
    ).fetchone()


def next_incident_id(conn: psycopg.Connection) -> str:
    rows = conn.execute("SELECT id FROM incidents WHERE id LIKE 'INC-%'").fetchall()
    n = 204
    for row in rows:
        suffix = row["id"].removeprefix("INC-")
        if suffix.isdigit():
            n = max(n, int(suffix) + 1)
    return f"INC-{n:04d}"


def create_incident(
    conn: psycopg.Connection,
    run_id: str,
    alarm: str,
    title: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    from datetime import datetime, timezone

    from storage.evidence import list_runs

    if not any(row["id"] == run_id for row in list_runs()):
        raise ValueError(f"unknown run {run_id}")
    incident_id = next_incident_id(conn)
    opened = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    label = (title or "").strip() or f"{alarm} · {run_id}"
    conn.execute(
        "INSERT INTO incidents (id, title, run_id, alarm, status, opened_at, notes) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (incident_id, label, run_id, alarm, "open", opened, notes),
    )
    conn.commit()
    row = get_incident(conn, incident_id)
    assert row is not None
    return dict(row)


SEED_INCIDENTS = (
    (
        "INC-0204",
        "Bus voltage warn",
        "eps204",
        "EPS.bus_voltage",
        "open",
        "2026-08-14T14:32:00Z",
        "Canonical EPS-204 demo. Operator already had the alarm; ORBIT did not detect it.",
    ),
    (
        "INC-0212",
        "Bus voltage — marginal loads",
        "marg001",
        "EPS.bus_voltage",
        "open",
        "2026-08-14T14:36:00Z",
        "Decoy signature. Same shape as EPS-204; correct outcome is hold, not inhibit.",
    ),
    (
        "INC-0205",
        "Heater-only bus sag",
        "fault1",
        "EPS.bus_voltage",
        "open",
        "2026-08-14T14:32:00Z",
        "Same heater fault as EPS-204; payload stayed STANDBY.",
    ),
    (
        "INC-0210",
        "Payload current warn",
        "pay002",
        "PAY.payload_current",
        "open",
        "2026-08-14T10:12:00Z",
        "FAULT-002 contrast. Payload is actually guilty. Do not inhibit Heater B.",
    ),
    (
        "INC-0211",
        "Battery voltage warn",
        "batt003",
        "EPS.battery_voltage",
        "open",
        "2026-08-14T00:10:00Z",
        "FAULT-003 contrast. Pack IR sag with a healthy heater.",
    ),
)


def ensure_demo_incident(conn: psycopg.Connection) -> None:
    """Seed the open roster if those ids are missing. Does not wipe operator incidents."""
    from storage.evidence import list_runs

    existing = {row["id"] for row in list_incidents(conn)}
    runs = {row["id"] for row in list_runs()}
    for incident_id, title, run_id, alarm, status, opened, notes in SEED_INCIDENTS:
        if incident_id in existing or run_id not in runs:
            continue
        conn.execute(
            "INSERT INTO incidents (id, title, run_id, alarm, status, opened_at, notes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (incident_id, title, run_id, alarm, status, opened, notes),
        )
    conn.commit()


def reset_demo_incidents(conn: psycopg.Connection) -> None:
    """Restore seeded demo cases to baseline. Called on each app load in demo mode."""
    seed_ids = [row[0] for row in SEED_INCIDENTS]
    for incident_id in seed_ids:
        conn.execute("DELETE FROM hypothesis_feedback WHERE incident_id = %s", (incident_id,))
    for incident_id, title, run_id, alarm, status, opened, notes in SEED_INCIDENTS:
        row = get_incident(conn, incident_id)
        if row is None:
            continue
        conn.execute(
            "UPDATE incidents SET title = %s, run_id = %s, alarm = %s, status = %s, "
            "opened_at = %s, notes = %s, filed_at = NULL, closeout = NULL, "
            "investigation_report = NULL, investigated_at = NULL WHERE id = %s",
            (title, run_id, alarm, status, opened, notes, incident_id),
        )
    conn.commit()
    ensure_demo_incident(conn)


def mark_incident_recommended(conn: psycopg.Connection, incident_id: str) -> dict[str, Any] | None:
    row = get_incident(conn, incident_id)
    if row is None:
        return None
    if row["status"] == "open":
        conn.execute(
            "UPDATE incidents SET status = %s WHERE id = %s",
            ("recommended", incident_id),
        )
        conn.commit()
        row = get_incident(conn, incident_id)
    return dict(row) if row else None


def save_investigation(
    conn: psycopg.Connection, incident_id: str, report: str
) -> dict[str, Any] | None:
    from datetime import datetime, timezone

    row = get_incident(conn, incident_id)
    if row is None:
        return None
    investigated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if row["status"] == "filed":
        conn.execute(
            "UPDATE incidents SET investigation_report = %s, investigated_at = %s WHERE id = %s",
            (report, investigated_at, incident_id),
        )
    else:
        status = "recommended" if row["status"] in ("open", "recommended") else row["status"]
        conn.execute(
            "UPDATE incidents SET status = %s, investigation_report = %s, investigated_at = %s "
            "WHERE id = %s",
            (status, report, investigated_at, incident_id),
        )
    conn.commit()
    row = get_incident(conn, incident_id)
    return dict(row) if row else None


def file_incident(
    conn: psycopg.Connection,
    incident_id: str,
    closeout: str,
    operator_note: str | None = None,
) -> dict[str, Any]:
    from datetime import datetime, timezone

    row = get_incident(conn, incident_id)
    if row is None:
        raise ValueError(f"unknown incident {incident_id}")
    if row["status"] == "filed":
        raise ValueError(f"{incident_id} is already filed")
    filed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    remark = (operator_note or "").strip() or None
    conn.execute(
        "UPDATE incidents SET status = %s, filed_at = %s, closeout = %s, notes = %s WHERE id = %s",
        ("filed", filed_at, closeout, remark, incident_id),
    )
    conn.commit()
    out = get_incident(conn, incident_id)
    assert out is not None
    return dict(out)


_FEEDBACK_COLS = (
    "incident_id, run_id, alarm, hypothesis_key, hypothesis_label, "
    "verdict, note, provider, created_at, updated_at"
)


def get_hypothesis_feedback(conn: psycopg.Connection, incident_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        f"SELECT {_FEEDBACK_COLS} FROM hypothesis_feedback WHERE incident_id = %s",
        (incident_id,),
    ).fetchone()
    return dict(row) if row else None


def list_hypothesis_feedback(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return list(
        conn.execute(
            f"SELECT {_FEEDBACK_COLS} FROM hypothesis_feedback ORDER BY updated_at DESC"
        ).fetchall()
    )


def upsert_hypothesis_feedback(
    conn: psycopg.Connection,
    incident_id: str,
    *,
    run_id: str,
    alarm: str,
    hypothesis_key: str,
    hypothesis_label: str,
    verdict: str,
    note: str | None = None,
    provider: str = "rules",
) -> dict[str, Any]:
    from datetime import datetime, timezone

    row = get_incident(conn, incident_id)
    if row is None:
        raise ValueError(f"unknown incident {incident_id}")
    if row["status"] == "filed":
        raise ValueError(f"{incident_id} is already filed")

    if verdict not in ("confirmed", "rejected"):
        raise ValueError("verdict must be confirmed or rejected")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    existing = get_hypothesis_feedback(conn, incident_id)
    created_at = existing["created_at"] if existing else now
    remark = (note or "").strip() or None

    conn.execute(
        "INSERT INTO hypothesis_feedback "
        "(incident_id, run_id, alarm, hypothesis_key, hypothesis_label, verdict, note, provider, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "ON CONFLICT (incident_id) DO UPDATE SET "
        "run_id = EXCLUDED.run_id, alarm = EXCLUDED.alarm, "
        "hypothesis_key = EXCLUDED.hypothesis_key, hypothesis_label = EXCLUDED.hypothesis_label, "
        "verdict = EXCLUDED.verdict, note = EXCLUDED.note, provider = EXCLUDED.provider, "
        "updated_at = EXCLUDED.updated_at",
        (
            incident_id,
            run_id,
            alarm,
            hypothesis_key,
            hypothesis_label,
            verdict,
            remark,
            provider,
            created_at,
            now,
        ),
    )
    conn.commit()
    out = get_hypothesis_feedback(conn, incident_id)
    assert out is not None
    return out


def store_trust_snapshot(conn: psycopg.Connection, spec: dict[str, Any]) -> dict[str, Any]:
    """Counts and health signals for the trust / data-sources console."""
    from storage.evidence import is_sealed_run_id, list_runs

    runs = list_runs()
    archive = [row for row in runs if not is_sealed_run_id(row["id"])]
    incidents = list_incidents(conn)
    inc_counts: dict[str, int] = {}
    for row in incidents:
        key = str(row.get("status") or "open")
        inc_counts[key] = inc_counts.get(key, 0) + 1

    channels = spec.get("channels") or {}
    warn_channels = sum(1 for meta in channels.values() if meta.get("warn_limit") is not None)
    samples = sum(int(row.get("samples") or 0) for row in archive)
    events_n = sum(int(row.get("events") or 0) for row in runs)

    return {
        "mission": spec.get("mission", {}).get("name") or "Aurora-1",
        "store": {
            "linked": len(archive) > 0,
            "runs": len(runs),
            "telemetry_samples": samples,
            "events": events_n,
            "channels_in_spec": len(channels),
            "warn_channels": warn_channels,
        },
        "incidents": {
            "total": len(incidents),
            "by_status": inc_counts,
        },
        "spec": {
            "fault_families": len(spec.get("fault_library") or {}),
            "procedures": len(spec.get("procedures_referenced") or {}),
            "historical_incidents": len(spec.get("historical_incidents_to_author") or []),
        },
        "investigator": {
            "provider_ui": "rules",
            "provider_cli": "rules | anthropic | openai",
            "paid_llm_in_ui": False,
        },
        "eval": {
            "cases": 5,
            "command": "python -m eval",
            "provider_default": "rules",
            "scorecard": _load_eval_scorecard(),
            "candidate_available": _eval_candidate_available(),
            "baseline_available": _eval_baseline_available(),
            "comparison": _load_eval_comparison(),
        },
        "runs": runs,
    }


def _load_eval_scorecard() -> dict[str, Any] | None:
    """Last full-suite scorecard written by `python -m eval` (if present)."""
    path = ROOT / "eval" / "scorecard.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _load_eval_json(filename: str) -> dict[str, Any] | None:
    path = ROOT / "eval" / filename
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _eval_candidate_available() -> bool:
    return (ROOT / "eval" / "candidate.json").exists()


def _eval_baseline_available() -> bool:
    return (ROOT / "eval" / "baseline.json").exists()


def _load_eval_baseline() -> dict[str, Any] | None:
    return _load_eval_json("baseline.json")


def _load_eval_candidate() -> dict[str, Any] | None:
    return _load_eval_json("candidate.json")


def _load_eval_comparison() -> dict[str, Any] | None:
    return _load_eval_json("comparison.json")


RUN_GENERATORS = {
    "eps204": lambda spec: run_eps204(spec, with_science_mode=True),
    "fault1": lambda spec: run_eps204(spec, with_science_mode=False),
    "marg001": run_marg001,
    "inc0187": run_inc0187,
    "pay002": run_pay002,
    "inc0191": run_inc0191,
    "batt003": run_batt003,
    "inc0162": run_inc0162,
    "nominal": run_nominal_slice,
}


def _ensure_run_csv(spec: dict[str, Any], run_id: str, path: Path) -> None:
    gen = RUN_GENERATORS.get(run_id)
    if gen is None:
        return
    if path.exists() and run_id != "nominal":
        return
    if path.exists() and run_id == "nominal":
        # Older 3-day nominal tapes are too large for the console workspace.
        with path.open() as handle:
            n = sum(1 for _ in handle) - 1
        if n <= 2000:
            return
    path.parent.mkdir(parents=True, exist_ok=True)
    df = gen(spec)
    df.to_csv(path, index=False)
    print(f"wrote {path}")


def _ingest_defaults(conn: psycopg.Connection, spec: dict[str, Any]) -> None:
    from storage.evidence import ARCHIVE, ensure_archive_tapes

    ensure_archive_tapes()
    for run_id, _scenario, path, _notes in ARCHIVE:
        if path.exists():
            print(f"tape {run_id}: {path.name}")
        else:
            print(f"skip {run_id}: {path} not found")
    ensure_demo_incident(conn)


def main() -> None:
    parser = argparse.ArgumentParser(description="ORBIT investigation store")
    parser.add_argument("--url", default=None, help="Postgres URL (default DATABASE_URL or local compose)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ingest", help="ensure tape files, case tables, and demo incidents")

    ch = sub.add_parser("channel", help="read one channel in a time window")
    ch.add_argument("run_id")
    ch.add_argument("channel")
    ch.add_argument("--from-clock", dest="from_clock", default=None)
    ch.add_argument("--to-clock", dest="to_clock", default=None)

    ev = sub.add_parser("events", help="list commands/mode changes for a run")
    ev.add_argument("run_id")

    doc = sub.add_parser("doc", help="print one procedure or prior incident")
    doc.add_argument("doc_id")

    args = parser.parse_args()
    conn = connect(args.url)
    init_schema(conn)

    if args.cmd == "ingest":
        spec = load_and_validate(SPEC_PATH)
        _ingest_defaults(conn, spec)
        print(f"db {args.url or os.environ.get('DATABASE_URL', DEFAULT_URL)}")
        return

    if args.cmd == "channel":
        start = clock_to_s(args.from_clock) if args.from_clock else None
        end = clock_to_s(args.to_clock) if args.to_clock else None
        from storage.evidence import query_channel

        rows = query_channel(args.run_id, args.channel, start, end)
        print(f"{args.run_id} {args.channel}  n={len(rows)}")
        for row in rows:
            val = row["value_text"] if row["value_text"] is not None else f"{row['value_num']:.3f}"
            print(f"  {format_clock(row['time_s'])}  {val}")
        return

    if args.cmd == "events":
        from storage.evidence import query_events

        for row in query_events(args.run_id):
            print(f"  {format_clock(row['time_s'])}  {row['event_type']}  {row['detail']}  {row['channel']}")
        return

    if args.cmd == "doc":
        from storage.evidence import get_document

        row = get_document(args.doc_id)
        if row is None:
            raise SystemExit(f"no document {args.doc_id}")
        print(f"# {row['id']} ({row['kind']})\n")
        print(row["body"])
        return


if __name__ == "__main__":
    main()
