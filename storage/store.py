"""Investigation store: runs, telemetry, events, procedures, incidents.

Postgres via Docker Compose. Local demo credentials live in docker-compose.yml
(orbit/orbit) — not a production secret. pgvector is not in this step.

This is not the agent. It is the data the agent's tools will query.
Embeddings for documents are local (fastembed), not a paid API.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

import pandas as pd
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
    run_nominal_slice,
    run_pay002,
)
from simulator.simulate import SPEC_PATH, load_and_validate

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"
DEFAULT_URL = "postgresql://orbit:orbit@localhost:5432/orbit"

SPEC_CHANNELS = (
    "EPS.bus_voltage",
    "EPS.bus_current",
    "EPS.battery_voltage",
    "EPS.battery_current",
    "EPS.solar_array_current",
    "THM.battery_temperature",
    "THM.heater_b_temperature",
    "THM.heater_b_current",
    "PAY.power_draw",
    "PAY.payload_current",
    "PAY.mode",
)


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
    for stmt in SCHEMA_PATH.read_text().split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        if _skip_redundant_alter(conn, stmt):
            continue
        conn.execute(stmt)
    conn.commit()


def _replace_run(conn: psycopg.Connection, run_id: str) -> None:
    filed = conn.execute(
        "SELECT id FROM incidents WHERE run_id = %s AND status = 'filed'",
        (run_id,),
    ).fetchall()
    for row in filed:
        conn.execute(
            "DELETE FROM documents WHERE id = %s AND path LIKE 'filed:%%'",
            (row["id"],),
        )
    conn.execute("DELETE FROM incidents WHERE run_id = %s", (run_id,))
    conn.execute("DELETE FROM events WHERE run_id = %s", (run_id,))
    conn.execute("DELETE FROM telemetry WHERE run_id = %s", (run_id,))
    conn.execute("DELETE FROM runs WHERE id = %s", (run_id,))


def ingest_run(
    conn: psycopg.Connection,
    csv_path: Path,
    run_id: str,
    scenario: str,
    events: list[tuple[float, str, str, str]],
    notes: str = "",
) -> int:
    """Load one simulator CSV as long-form telemetry. Returns sample count."""
    df = pd.read_csv(csv_path)
    _replace_run(conn, run_id)
    started = str(df["timestamp"].iloc[0])
    conn.execute(
        "INSERT INTO runs (id, scenario, source_csv, started_at, notes) VALUES (%s, %s, %s, %s, %s)",
        (run_id, scenario, str(csv_path), started, notes),
    )

    rows: list[tuple[Any, ...]] = []
    for rec_map in df.to_dict(orient="records"):
        time_s = float(rec_map["time_s"])
        timestamp = str(rec_map["timestamp"])
        for channel in SPEC_CHANNELS:
            raw = rec_map[channel]
            if channel == "PAY.mode":
                rows.append((run_id, time_s, timestamp, channel, None, str(raw)))
            else:
                rows.append((run_id, time_s, timestamp, channel, float(raw), None))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO telemetry (run_id, time_s, timestamp, channel, value_num, value_text) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )

    event_rows = []
    for time_s, event_type, channel, detail in events:
        ts = df.loc[(df["time_s"] - time_s).abs().idxmin(), "timestamp"]
        event_rows.append((run_id, time_s, str(ts), event_type, channel, detail))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO events (run_id, time_s, timestamp, event_type, channel, detail) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            event_rows,
        )
    conn.commit()
    return len(df)


def ingest_documents(conn: psycopg.Connection, spec: dict[str, Any]) -> int:
    from storage.embed import as_pgvector, embed_texts

    docs: list[tuple[str, str, str, str, str]] = []
    for proc_id, meta in spec["procedures_referenced"].items():
        path = ROOT / meta["path"]
        docs.append((proc_id, "procedure", meta["title"], str(path), path.read_text()))
    for inc in spec["historical_incidents_to_author"]:
        path = ROOT / inc["path"]
        docs.append((inc["id"], "incident", inc["id"], str(path), path.read_text()))

    authored = [doc_id for doc_id, *_ in docs]
    conn.execute("DELETE FROM documents WHERE id = ANY(%s)", (authored,))

    for doc_id, kind, title, path, body in docs:
        conn.execute(
            "INSERT INTO documents (id, kind, title, path, body) VALUES (%s, %s, %s, %s, %s)",
            (doc_id, kind, title, path, body),
        )
    vectors = embed_texts([f"{title}\n{body}" for _, _, title, _, body in docs])
    for (doc_id, *_), vec in zip(docs, vectors):
        conn.execute(
            "UPDATE documents SET embedding = %s::vector WHERE id = %s",
            (as_pgvector(vec), doc_id),
        )
    conn.commit()
    return len(docs)


def events_for_run(spec: dict[str, Any], run_id: str) -> list[tuple[float, str, str, str]]:
    if run_id in ("eps204", "fault1"):
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


def query_channel(
    conn: psycopg.Connection,
    run_id: str,
    channel: str,
    start_s: float | None = None,
    end_s: float | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT time_s, timestamp, value_num, value_text FROM telemetry WHERE run_id = %s AND channel = %s"
    params: list[Any] = [run_id, channel]
    if start_s is not None:
        sql += " AND time_s >= %s"
        params.append(start_s)
    if end_s is not None:
        sql += " AND time_s <= %s"
        params.append(end_s)
    sql += " ORDER BY time_s"
    return list(conn.execute(sql, params).fetchall())


def query_events(conn: psycopg.Connection, run_id: str) -> list[dict[str, Any]]:
    return list(
        conn.execute(
            "SELECT time_s, timestamp, event_type, channel, detail FROM events "
            "WHERE run_id = %s ORDER BY time_s",
            (run_id,),
        ).fetchall()
    )


def list_runs(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return list(
        conn.execute("SELECT id, scenario, started_at, notes FROM runs ORDER BY id").fetchall()
    )


_INCIDENT_COLS = (
    "id, title, run_id, alarm, status, opened_at, notes, filed_at, closeout"
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

    if not any(row["id"] == run_id for row in list_runs(conn)):
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
    existing = {row["id"] for row in list_incidents(conn)}
    runs = {row["id"] for row in list_runs(conn)}
    for incident_id, title, run_id, alarm, status, opened, notes in SEED_INCIDENTS:
        if incident_id in existing or run_id not in runs:
            continue
        conn.execute(
            "INSERT INTO incidents (id, title, run_id, alarm, status, opened_at, notes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (incident_id, title, run_id, alarm, status, opened, notes),
        )
    conn.commit()


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


def upsert_filed_document(conn: psycopg.Connection, incident_id: str, title: str, body: str) -> None:
    from storage.embed import as_pgvector, embed_texts

    path = f"filed:{incident_id}"
    conn.execute(
        "INSERT INTO documents (id, kind, title, path, body) VALUES (%s, %s, %s, %s, %s) "
        "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, path = EXCLUDED.path, body = EXCLUDED.body",
        (incident_id, "incident", title, path, body),
    )
    vec = as_pgvector(embed_texts([f"{title}\n{body}"])[0])
    conn.execute(
        "UPDATE documents SET embedding = %s::vector WHERE id = %s",
        (vec, incident_id),
    )


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
    upsert_filed_document(conn, incident_id, row["title"], closeout)
    conn.commit()
    out = get_incident(conn, incident_id)
    assert out is not None
    return dict(out)


def list_documents(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return list(
        conn.execute("SELECT id, kind, title FROM documents ORDER BY kind, id").fetchall()
    )


def get_document(conn: psycopg.Connection, doc_id: str) -> dict[str, Any] | None:
    return conn.execute(
        "SELECT id, kind, title, path, body FROM documents WHERE id = %s", (doc_id,)
    ).fetchone()


def search_documents(conn: psycopg.Connection, query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Semantic search over procedures/incidents. Local embeddings, not a paid API."""
    from storage.embed import as_pgvector, embed_texts

    n_embedded = conn.execute(
        "SELECT COUNT(*) AS n FROM documents WHERE embedding IS NOT NULL"
    ).fetchone()["n"]
    if n_embedded:
        vec = as_pgvector(embed_texts([query])[0])
        return list(
            conn.execute(
                "SELECT id, kind, title, 1 - (embedding <=> %s::vector) AS score "
                "FROM documents WHERE embedding IS NOT NULL "
                "ORDER BY embedding <=> %s::vector LIMIT %s",
                (vec, vec, limit),
            ).fetchall()
        )
    return list(
        conn.execute(
            "SELECT id, kind, title, NULL AS score FROM documents "
            "WHERE body ILIKE %s ORDER BY kind, id",
            (f"%{query}%",),
        ).fetchall()
    )


RUN_GENERATORS = {
    "eps204": lambda spec: run_eps204(spec, with_science_mode=True),
    "fault1": lambda spec: run_eps204(spec, with_science_mode=False),
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
    catalog = (
        ("eps204", "eps204", ROOT / "runs" / "eps204.csv", "demo: heater fault + science-mode confounder"),
        ("fault1", "fault1", ROOT / "runs" / "fault1.csv", "heater fault only"),
        ("inc0187", "inc0187", ROOT / "runs" / "inc0187.csv", "prior incident source run"),
        ("pay002", "pay002", ROOT / "runs" / "pay002.csv", "payload overcurrent on SCIENCE_MODE"),
        ("inc0191", "inc0191", ROOT / "runs" / "inc0191.csv", "prior payload-spike source run"),
        ("batt003", "batt003", ROOT / "runs" / "batt003.csv", "pack IR sag, heater healthy"),
        ("inc0162", "inc0162", ROOT / "runs" / "inc0162.csv", "prior pack-IR source run"),
        ("nominal", "nominal", ROOT / "runs" / "nominal.csv", "healthy SCIENCE_MODE control tape"),
    )
    for run_id, scenario, path, notes in catalog:
        _ensure_run_csv(spec, run_id, path)
        if not path.exists():
            print(f"skip {run_id}: {path} not found")
            continue
        n = ingest_run(conn, path, run_id, scenario, events_for_run(spec, run_id), notes)
        print(f"ingested {run_id}: {n} samples")
    n_docs = ingest_documents(conn, spec)
    print(f"ingested {n_docs} documents")
    ensure_demo_incident(conn)


def main() -> None:
    parser = argparse.ArgumentParser(description="ORBIT investigation store")
    parser.add_argument("--url", default=None, help="Postgres URL (default DATABASE_URL or local compose)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ingest", help="load default runs + procedures + historical incidents")

    ch = sub.add_parser("channel", help="read one channel in a time window")
    ch.add_argument("run_id")
    ch.add_argument("channel")
    ch.add_argument("--from-clock", dest="from_clock", default=None)
    ch.add_argument("--to-clock", dest="to_clock", default=None)

    ev = sub.add_parser("events", help="list commands/mode changes for a run")
    ev.add_argument("run_id")

    doc = sub.add_parser("doc", help="print a procedure or incident")
    doc.add_argument("doc_id")

    sem = sub.add_parser("search", help="semantic search over procedures and incidents")
    sem.add_argument("query")

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
        rows = query_channel(conn, args.run_id, args.channel, start, end)
        print(f"{args.run_id} {args.channel}  n={len(rows)}")
        for row in rows:
            val = row["value_text"] if row["value_text"] is not None else f"{row['value_num']:.3f}"
            print(f"  {format_clock(row['time_s'])}  {val}")
        return

    if args.cmd == "events":
        for row in query_events(conn, args.run_id):
            print(f"  {format_clock(row['time_s'])}  {row['event_type']}  {row['detail']}  {row['channel']}")
        return

    if args.cmd == "doc":
        row = get_document(conn, args.doc_id)
        if row is None:
            raise SystemExit(f"no document {args.doc_id}")
        print(f"# {row['id']} ({row['kind']})\n")
        print(row["body"])
        return

    if args.cmd == "search":
        for row in search_documents(conn, args.query):
            score = row["score"]
            extra = f"  score={float(score):.3f}" if score is not None else ""
            print(f"{row['id']:12} {row['kind']:10}{extra}")
        return


if __name__ == "__main__":
    main()
