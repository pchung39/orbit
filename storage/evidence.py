"""Tape files and the one named procedure or prior a case asks for.

Archive tapes live in runs/*.csv. Opening a case writes a window to
runs/sealed/. Procedures and authored priors stay as markdown. Postgres
does not store telemetry or a document index.
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any

import pandas as pd

from simulator.scenarios import clock_to_s, format_clock
from simulator.simulate import SPEC_PATH, load_and_validate

ROOT = Path(__file__).resolve().parent.parent
SEALED_DIR = ROOT / "runs" / "sealed"

ARCHIVE: tuple[tuple[str, str, Path, str], ...] = (
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

_frames: dict[str, pd.DataFrame] = {}
_seals_restored = False

# Same pads seal_run_window uses when a case has no stored window clocks.
_PAD_BEFORE_S = 600.0
_PAD_AFTER_S = 300.0
_SEALED_ID = re.compile(r"^sealed_(?P<source>.+)_(?P<clock>\d{6})_[0-9a-f]{4}$")
_SEALED_FROM = re.compile(r"sealed from ([^\s·]+)")
_SEALED_WINDOW = re.compile(
    r"window\s+(\d{2}:\d{2}:\d{2})\s*(?:\u2013|-)\s*(\d{2}:\d{2}:\d{2})"
)


def is_sealed_run_id(run_id: str) -> bool:
    return str(run_id).startswith("sealed_")


def archive_entry(run_id: str) -> tuple[str, str, Path, str] | None:
    for row in ARCHIVE:
        if row[0] == run_id:
            return row
    return None


def sealed_csv_path(run_id: str) -> Path:
    return SEALED_DIR / f"{run_id}.csv"


def sealed_meta_path(run_id: str) -> Path:
    return SEALED_DIR / f"{run_id}.json"


def read_sealed_meta(run_id: str) -> dict[str, Any] | None:
    path = sealed_meta_path(run_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def ensure_archive_csv(run_id: str, path: Path) -> None:
    from storage.store import _ensure_run_csv

    spec = load_and_validate(SPEC_PATH)
    _ensure_run_csv(spec, run_id, path)


def ensure_archive_tapes() -> None:
    for run_id, _scenario, path, _notes in ARCHIVE:
        ensure_archive_csv(run_id, path)


def _load_csv(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    df = pd.read_csv(path)
    if "time_s" not in df.columns or df.empty:
        return None
    return df


def _case_for_run(run_id: str) -> dict[str, Any] | None:
    try:
        from storage.store import connect, list_incidents
    except Exception:
        return None
    try:
        with connect() as conn:
            for row in list_incidents(conn):
                if str(row["run_id"]) == run_id:
                    return dict(row)
    except Exception:
        return None
    return None


def _sealed_bounds(run_id: str, notes: str | None) -> tuple[str, float, float] | None:
    """Source tape and window clocks from the case note, or from the sealed id."""
    source = None
    t0 = t1 = None
    if notes:
        found = _SEALED_FROM.search(notes)
        if found:
            source = found.group(1)
        window = _SEALED_WINDOW.search(notes)
        if window:
            t0 = float(clock_to_s(window.group(1)))
            t1 = float(clock_to_s(window.group(2)))
    parsed = _SEALED_ID.match(run_id)
    if parsed:
        source = source or parsed.group("source")
        if t0 is None or t1 is None:
            raw = parsed.group("clock")
            center = float(clock_to_s(f"{raw[0:2]}:{raw[2:4]}:{raw[4:6]}"))
            t0 = max(0.0, center - _PAD_BEFORE_S)
            t1 = center + _PAD_AFTER_S
    if not source or archive_entry(source) is None or t0 is None or t1 is None:
        return None
    return source, float(t0), float(t1)


def restore_sealed_window(
    run_id: str,
    notes: str | None = None,
    alarm: str | None = None,
) -> pd.DataFrame | None:
    """Rewrite a sealed CSV when the case still names the window but the file is gone.

    Older cases kept that window in Postgres. The case note (or the sealed id)
    still says which archive tape and clocks to cut.
    """
    if not is_sealed_run_id(run_id):
        return None
    existing = _load_csv(sealed_csv_path(run_id))
    if existing is not None:
        return existing
    if notes is None and alarm is None:
        case = _case_for_run(run_id)
        if case:
            notes = case.get("notes")
            alarm = case.get("alarm")
    bounds = _sealed_bounds(run_id, notes if isinstance(notes, str) else None)
    if bounds is None:
        return None
    source, t0, t1 = bounds
    entry = archive_entry(source)
    if entry is None:
        return None
    _run_id, scenario, path, _archive_notes = entry
    ensure_archive_csv(source, path)
    df = _load_csv(path)
    if df is None:
        return None
    window = df[(df["time_s"] >= t0) & (df["time_s"] <= t1)].copy()
    if window.empty:
        return None
    SEALED_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = sealed_csv_path(run_id)
    window.to_csv(csv_path, index=False)
    if not sealed_meta_path(run_id).exists():
        clock = format_clock((t0 + t1) / 2)
        note = notes if isinstance(notes, str) and notes.strip() else (
            f"sealed from {source} · {alarm or 'alarm'} @ {clock} · "
            f"window {format_clock(t0)}–{format_clock(t1)} · fetch-on-seal · demo-local"
        )
        meta = {
            "id": run_id,
            "source_run_id": source,
            "scenario": scenario,
            "alarm": alarm or "",
            "t0": t0,
            "t1": t1,
            "started_at": str(window["timestamp"].iloc[0]),
            "notes": note,
            "source_csv": str(csv_path),
        }
        sealed_meta_path(run_id).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    frame = window.reset_index(drop=True)
    _frames[run_id] = frame
    return frame


def restore_missing_seals() -> None:
    """Materialize sealed files for every case whose window file is missing."""
    global _seals_restored
    if _seals_restored:
        return
    try:
        from storage.store import connect, list_incidents
    except Exception:
        return
    try:
        with connect() as conn:
            cases = [
                dict(row)
                for row in list_incidents(conn)
                if is_sealed_run_id(str(row["run_id"]))
            ]
    except Exception:
        return
    for case in cases:
        restore_sealed_window(str(case["run_id"]), case.get("notes"), case.get("alarm"))
    _seals_restored = True


def load_frame(run_id: str) -> pd.DataFrame | None:
    cached = _frames.get(run_id)
    if cached is not None:
        return cached
    if is_sealed_run_id(run_id):
        df = _load_csv(sealed_csv_path(run_id))
        if df is None:
            df = restore_sealed_window(run_id)
    else:
        entry = archive_entry(run_id)
        if entry is None:
            return None
        _run_id, _scenario, path, _notes = entry
        ensure_archive_csv(run_id, path)
        df = _load_csv(path)
    if df is None:
        return None
    _frames[run_id] = df
    return df


def _channel_rows(df: pd.DataFrame, channel: str) -> list[dict[str, Any]]:
    if channel not in df.columns:
        return []
    rows: list[dict[str, Any]] = []
    for rec in df.to_dict(orient="records"):
        raw = rec.get(channel)
        if pd.isna(raw):
            continue
        time_s = float(rec["time_s"])
        timestamp = str(rec["timestamp"])
        if channel == "PAY.mode":
            rows.append(
                {"time_s": time_s, "timestamp": timestamp, "value_num": None, "value_text": str(raw)}
            )
            continue
        try:
            value_num = float(raw)
            value_text = None
        except (TypeError, ValueError):
            value_num = None
            value_text = str(raw)
        rows.append(
            {
                "time_s": time_s,
                "timestamp": timestamp,
                "value_num": value_num,
                "value_text": value_text,
            }
        )
    return rows


def query_channel(
    run_id: str,
    channel: str,
    start_s: float | None = None,
    end_s: float | None = None,
) -> list[dict[str, Any]]:
    df = load_frame(run_id)
    if df is None:
        return []
    rows = _channel_rows(df, channel)
    if start_s is not None:
        rows = [row for row in rows if row["time_s"] >= start_s]
    if end_s is not None:
        rows = [row for row in rows if row["time_s"] <= end_s]
    rows.sort(key=lambda row: row["time_s"])
    return rows


def _timestamp_at(df: pd.DataFrame, time_s: float) -> str:
    idx = (df["time_s"] - time_s).abs().idxmin()
    return str(df.loc[idx, "timestamp"])


def query_events(run_id: str) -> list[dict[str, Any]]:
    from storage.store import events_for_run

    df = load_frame(run_id)
    if df is None:
        return []
    if is_sealed_run_id(run_id):
        meta = read_sealed_meta(run_id) or {}
        source = str(meta.get("source_run_id") or "")
        t0 = meta.get("t0")
        t1 = meta.get("t1")
    else:
        source = run_id
        t0 = float(df["time_s"].min())
        t1 = float(df["time_s"].max())
    if not source:
        return []
    spec = load_and_validate(SPEC_PATH)
    rows: list[dict[str, Any]] = []
    for time_s, event_type, channel, detail in events_for_run(spec, source):
        if t0 is not None and time_s < float(t0):
            continue
        if t1 is not None and time_s > float(t1):
            continue
        rows.append(
            {
                "time_s": float(time_s),
                "timestamp": _timestamp_at(df, float(time_s)),
                "event_type": event_type,
                "channel": channel,
                "detail": detail,
            }
        )
    rows.sort(key=lambda row: row["time_s"])
    return rows


def _span(df: pd.DataFrame) -> tuple[float, float, str]:
    t0 = float(df["time_s"].min())
    t1 = float(df["time_s"].max())
    started = str(df.loc[df["time_s"].idxmin(), "timestamp"])
    return t0, t1, started


def run_record(run_id: str) -> dict[str, Any] | None:
    df = load_frame(run_id)
    if df is None:
        return None
    t0, t1, started = _span(df)
    if is_sealed_run_id(run_id):
        meta = read_sealed_meta(run_id) or {}
        scenario = str(meta.get("scenario") or "sealed")
        notes = str(meta.get("notes") or "")
    else:
        entry = archive_entry(run_id)
        if entry is None:
            return None
        _run_id, scenario, _path, notes = entry
    return {
        "id": run_id,
        "scenario": scenario,
        "started_at": started,
        "notes": notes,
        "samples": int(len(df)),
        "events": len(query_events(run_id)),
        "clock_start": format_clock(t0),
        "clock_end": format_clock(t1),
    }


def list_runs() -> list[dict[str, Any]]:
    restore_missing_seals()
    rows: list[dict[str, Any]] = []
    for run_id, _scenario, path, _notes in ARCHIVE:
        ensure_archive_csv(run_id, path)
        record = run_record(run_id)
        if record is not None:
            rows.append(record)
    if SEALED_DIR.exists():
        for meta_path in sorted(SEALED_DIR.glob("sealed_*.json")):
            record = run_record(meta_path.stem)
            if record is not None:
                rows.append(record)
    rows.sort(key=lambda row: row["id"])
    return rows


def allocate_sealed_id(source_run_id: str, center_s: float) -> str:
    existing = {row["id"] for row in list_runs()}
    clock_part = format_clock(center_s).replace(":", "")
    for _ in range(8):
        candidate = f"sealed_{source_run_id}_{clock_part}_{secrets.token_hex(2)}"
        if candidate not in existing:
            return candidate
    raise ValueError("could not allocate a unique sealed run id")


def write_sealed_window(
    source_run_id: str,
    scenario: str,
    alarm: str,
    center_s: float,
    t0: float,
    t1: float,
    window: pd.DataFrame,
    notes: str,
) -> str:
    """Write the warn window as a CSV plus a sidecar. Returns the sealed run id."""
    SEALED_DIR.mkdir(parents=True, exist_ok=True)
    sealed_id = allocate_sealed_id(source_run_id, center_s)
    csv_path = sealed_csv_path(sealed_id)
    window.to_csv(csv_path, index=False)
    started = str(window["timestamp"].iloc[0])
    meta = {
        "id": sealed_id,
        "source_run_id": source_run_id,
        "scenario": scenario,
        "alarm": alarm,
        "t0": t0,
        "t1": t1,
        "started_at": started,
        "notes": notes,
        "source_csv": str(csv_path),
    }
    sealed_meta_path(sealed_id).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    _frames[sealed_id] = window.reset_index(drop=True)
    return sealed_id


def get_document(doc_id: str) -> dict[str, Any] | None:
    """Read one procedure or authored prior by id. No search index."""
    spec = load_and_validate(SPEC_PATH)
    procs = spec.get("procedures_referenced") or {}
    if doc_id in procs:
        meta = procs[doc_id]
        path = ROOT / meta["path"]
        if not path.exists():
            return None
        return {
            "id": doc_id,
            "kind": "procedure",
            "title": meta.get("title") or doc_id,
            "path": str(path),
            "body": path.read_text(encoding="utf-8"),
        }
    for inc in spec.get("historical_incidents_to_author") or []:
        if inc.get("id") != doc_id:
            continue
        path = ROOT / inc["path"]
        if not path.exists():
            return None
        body = path.read_text(encoding="utf-8")
        title = doc_id
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        return {
            "id": doc_id,
            "kind": "incident",
            "title": title,
            "path": str(path),
            "body": body,
        }
    return None
