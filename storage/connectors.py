"""History sources: where the mission's telemetry and command log come from.

Two kinds today:
  postgres   any Postgres-compatible database (TimescaleDB included), read-only
  csv        files: the generated dummy mission, or CSVs a team uploads

Every source is described by a SourceConfig: how to reach it, plus a mapping
from the team's table and names to ORBIT's channels and commands. The rest of
ORBIT (model learning, the history summary) asks load_history() and never
knows which kind it got.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg
from psycopg import sql

from simulator import mission
from simulator.simulate import load_and_validate

ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = ROOT / "runs" / "sources"
ACTIVE_JSON = SOURCES_DIR / "active.json"
UPLOAD_DIR = SOURCES_DIR / "uploads"

ORBIT_COMMANDS = {
    "HEATER_B_ENABLE": "Turns Heater B on",
    "HEATER_B_DISABLE": "Turns Heater B off",
    "SCIENCE_MODE": "Payload into science mode",
    "PAYLOAD_STANDBY": "Payload back to standby",
}

# Common ways teams name ORBIT's channels. Used only to *suggest*; a person confirms.
ALIASES = {
    "EPS.bus_voltage": ["bus_v", "vbus", "bus_volt", "busv", "eps_bus_v", "bus_voltage"],
    "EPS.bus_current": ["bus_i", "ibus", "bus_curr", "eps_bus_i", "bus_current"],
    "EPS.battery_voltage": ["bat_v", "batt_v", "vbat", "battery_v", "battery_voltage"],
    "EPS.battery_current": ["bat_i", "batt_i", "ibat", "battery_i", "battery_current"],
    "EPS.solar_array_current": ["sa_i", "solar_i", "array_i", "isa", "solar_array_current"],
    "THM.battery_temperature": ["bat_temp", "batt_t", "tbat", "battery_temperature"],
    "THM.heater_b_temperature": ["htr_b_temp", "heater_b_t", "thtr_b", "heater_b_temperature"],
    "THM.heater_b_current": ["htr_b_i", "heater_b_i", "ihtr_b", "heater_b_current"],
    "PAY.power_draw": ["pl_pwr", "payload_p", "pay_pwr", "power_draw"],
    "PAY.payload_current": ["pl_i", "pl_i_ma", "payload_i", "pay_i", "payload_current"],
    "PAY.mode": ["pl_mode", "payload_mode", "pay_mode", "mode"],
}
COMMAND_ALIASES = {
    "HEATER_B_ENABLE": ["HTR_B_ON", "HEATER_B_ON", "HEATER_B_ENABLE", "HTRB_EN"],
    "HEATER_B_DISABLE": ["HTR_B_OFF", "HEATER_B_OFF", "HEATER_B_DISABLE", "HTRB_DIS"],
    "SCIENCE_MODE": ["PL_MODE_SCI", "PAYLOAD_SCIENCE", "SCIENCE_MODE", "PL_SCI"],
    "PAYLOAD_STANDBY": ["PL_MODE_STBY", "PAYLOAD_STANDBY", "PL_STBY", "PL_SAFE"],
}


@dataclass
class SourceConfig:
    kind: str                      # "postgres" | "csv"
    name: str
    url: str | None = None         # postgres
    files: dict[str, str] = field(default_factory=dict)  # csv: {"telemetry": path, "commands": path}
    layout: str = "wide"           # telemetry layout: "long" (one row per sample) | "wide" (one column per channel)
    table: str | None = None
    time_col: str = "time_s"
    channel_col: str | None = None
    value_col: str | None = None
    text_col: str | None = None
    channels: dict[str, dict[str, Any]] = field(default_factory=dict)  # orbit -> {"source": name, "scale": k}
    commands: dict[str, Any] = field(default_factory=dict)  # {"table", "time_col", "command_col", "map": {theirs: orbit}}
    synthetic: bool = False
    saved_at: str | None = None

    @property
    def stamp(self) -> str:
        return f"{self.kind}:{self.saved_at or 'builtin'}"


def masked(url: str | None) -> str | None:
    return re.sub(r"(//[^:/@]+:)[^@]*@", r"\1•••@", url) if url else url


# ── Active source ────────────────────────────────────────────────────────────

def dummy_csv_config() -> SourceConfig:
    """The generated dummy mission, already in ORBIT's names. The default until a team connects."""
    mission.ensure_mission()
    spec = load_and_validate()
    chans = {c: {"source": c, "scale": 1.0} for c in spec["channels"]}
    return SourceConfig(
        kind="csv", name="Aurora-1 · dummy mission history",
        files={"telemetry": str(mission.TELEMETRY_CSV), "commands": str(mission.COMMANDS_CSV)},
        layout="wide", time_col="timestamp", channels=chans,
        commands={"time_col": "timestamp", "command_col": "command", "map": {c: c for c in ORBIT_COMMANDS}},
        synthetic=True,
    )


def active_config() -> SourceConfig:
    if ACTIVE_JSON.exists():
        return SourceConfig(**json.loads(ACTIVE_JSON.read_text()))
    return dummy_csv_config()


def save_config(cfg: SourceConfig) -> SourceConfig:
    cfg.saved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    ACTIVE_JSON.write_text(json.dumps(asdict(cfg), indent=2))
    return cfg


def reset_to_dummy() -> SourceConfig:
    ACTIVE_JSON.unlink(missing_ok=True)
    return dummy_csv_config()


# ── Loading history in ORBIT's terms ─────────────────────────────────────────

def load_history(cfg: SourceConfig | None = None) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """(telemetry wide in ORBIT channel names with time_s, commands with time_s/command/mapped, info)."""
    cfg = cfg or active_config()
    return _load_cached(json.dumps(asdict(cfg), sort_keys=True))


@lru_cache(maxsize=2)
def _load_cached(cfg_json: str) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    cfg = SourceConfig(**json.loads(cfg_json))
    t0 = time.perf_counter()
    raw_tel, raw_cmd = (_pg_frames(cfg) if cfg.kind == "postgres" else _csv_frames(cfg))
    elapsed = time.perf_counter() - t0

    ts = pd.to_datetime(raw_tel["__ts"], utc=True)
    start = ts.min()
    tel = pd.DataFrame({"time_s": (ts - start).dt.total_seconds()})
    for orbit, m in cfg.channels.items():
        col = raw_tel.get(m["source"])
        if col is None:
            continue
        tel[orbit] = col if orbit == "PAY.mode" else pd.to_numeric(col, errors="coerce") * float(m.get("scale", 1.0))
    tel["timestamp"] = ts.map(lambda t: t.isoformat())
    tel = tel.sort_values("time_s").reset_index(drop=True)

    cmd_map = (cfg.commands or {}).get("map", {})
    cmds = pd.DataFrame(columns=["time_s", "command", "source_name", "mapped"])
    if raw_cmd is not None and len(raw_cmd):
        cts = pd.to_datetime(raw_cmd["__ts"], utc=True)
        names = raw_cmd["__cmd"].astype(str)
        cmds = pd.DataFrame({
            "time_s": (cts - start).dt.total_seconds().round(),
            "command": names.map(lambda n: cmd_map.get(n, n)),
            "source_name": names,
            "mapped": names.map(lambda n: n in cmd_map),
        }).sort_values("time_s").reset_index(drop=True)

    dts = np.diff(tel["time_s"].to_numpy())
    dt = float(np.median(dts)) if len(dts) else 10.0
    end = ts.max()
    info = {
        "name": cfg.name,
        "kind": "Postgres database" if cfg.kind == "postgres" else "CSV files",
        "synthetic": cfg.synthetic,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": max(1, int(round((end - start).total_seconds() / 86400))),
        "sample_interval_s": round(dt, 2),
        "rows": int(len(tel)),
        "channels": [c for c in cfg.channels if c in tel.columns],
        "load_seconds": round(elapsed, 2),
        "stamp": cfg.stamp,
    }
    return tel, cmds, info


def _csv_frames(cfg: SourceConfig) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    tel = pd.read_csv(cfg.files["telemetry"])
    if cfg.layout == "long":
        tel = _pivot_long(tel, cfg.time_col, cfg.channel_col, cfg.value_col, cfg.text_col)
    else:
        tel = tel.rename(columns={cfg.time_col: "__ts"})
    cmd = None
    if cfg.files.get("commands") and cfg.commands:
        c = pd.read_csv(cfg.files["commands"])
        cmd = pd.DataFrame({"__ts": c[cfg.commands["time_col"]], "__cmd": c[cfg.commands["command_col"]]})
    return tel, cmd


def _pivot_long(df: pd.DataFrame, time_col: str, ch_col: str, val_col: str, text_col: str | None) -> pd.DataFrame:
    num = df.pivot_table(index=time_col, columns=ch_col, values=val_col, aggfunc="first")
    if text_col and text_col in df.columns and df[text_col].notna().any():
        txt = df[df[text_col].notna()].pivot_table(index=time_col, columns=ch_col, values=text_col, aggfunc="first")
        num = num.drop(columns=[c for c in txt.columns if c in num.columns]).join(txt, how="outer")
    out = num.reset_index().rename(columns={time_col: "__ts"})
    out.columns.name = None
    return out


def _pg_frames(cfg: SourceConfig) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    wanted = [m["source"] for m in cfg.channels.values()]
    with psycopg.connect(cfg.url, connect_timeout=5) as conn:
        if cfg.layout == "long":
            cols = [sql.Identifier(cfg.time_col), sql.Identifier(cfg.channel_col), sql.Identifier(cfg.value_col)]
            if cfg.text_col:
                cols.append(sql.Identifier(cfg.text_col))
            q = sql.SQL("SELECT {} FROM {} WHERE {} = ANY(%s)").format(
                sql.SQL(", ").join(cols), sql.Identifier(cfg.table), sql.Identifier(cfg.channel_col))
            with conn.cursor() as cur:
                cur.execute(q, (wanted,))
                names = [d.name for d in cur.description]
                df = pd.DataFrame(cur.fetchall(), columns=names)
            tel = _pivot_long(df, cfg.time_col, cfg.channel_col, cfg.value_col, cfg.text_col)
        else:
            q = sql.SQL("SELECT {} FROM {}").format(
                sql.SQL(", ").join([sql.Identifier(cfg.time_col)] + [sql.Identifier(w) for w in wanted]),
                sql.Identifier(cfg.table))
            with conn.cursor() as cur:
                cur.execute(q)
                tel = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description]).rename(columns={cfg.time_col: "__ts"})
        cmd = None
        c = cfg.commands or {}
        if c.get("table"):
            q = sql.SQL("SELECT {} AS __ts, {} AS __cmd FROM {}").format(
                sql.Identifier(c["time_col"]), sql.Identifier(c["command_col"]), sql.Identifier(c["table"]))
            with conn.cursor() as cur:
                cur.execute(q)
                cmd = pd.DataFrame(cur.fetchall(), columns=["__ts", "__cmd"])
    return tel, cmd


# ── Connect flow: test, inspect, suggest ─────────────────────────────────────

def pg_test(url: str) -> dict[str, Any]:
    t0 = time.perf_counter()
    try:
        with psycopg.connect(url, connect_timeout=4) as conn:
            version = conn.execute("SHOW server_version").fetchone()[0]
            timescale = bool(conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'").fetchone())
            can_write = bool(conn.execute(
                "SELECT bool_or(has_table_privilege(c.oid, 'INSERT')) FROM pg_class c "
                "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'"
            ).fetchone()[0])
            rows = conn.execute(
                "SELECT c.relname, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY c.relname"
            ).fetchall()
            tables = []
            for name, est in rows:
                cols = conn.execute(
                    "SELECT column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position", (name,)
                ).fetchall()
                tables.append({"name": name, "rows": max(int(est), 0), "columns": [{"name": c, "type": t} for c, t in cols]})
            synthetic = False
            if any(t["name"] == "dataset_info" for t in tables):
                r = conn.execute("SELECT value FROM dataset_info WHERE key = 'synthetic'").fetchone()
                synthetic = bool(r and r[0] == "true")
        return {"ok": True, "latency_ms": round((time.perf_counter() - t0) * 1000), "server": f"PostgreSQL {version}",
                "timescale": timescale, "read_only": not can_write, "tables": tables,
                "guess": _guess_tables(tables), "synthetic": synthetic}
    except Exception as exc:
        return {"ok": False, "error": _friendly(exc)}


def _friendly(exc: Exception) -> str:
    msg = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    if "password authentication failed" in msg:
        return "The database rejected the username or password."
    if "does not exist" in msg and "database" in msg:
        return "That database name doesn't exist on the server."
    if "Connection refused" in msg or "could not connect" in msg or "timeout" in msg.lower():
        return "Couldn't reach the server. Check the host, port, and that it accepts connections."
    return msg


def _guess_tables(tables: list[dict[str, Any]]) -> dict[str, Any]:
    def score_tel(t: dict[str, Any]) -> float:
        names = {c["name"].lower() for c in t["columns"]}
        has_time = any("timestamp" in c["type"] for c in t["columns"])
        long = bool(names & {"channel", "name", "signal", "metric", "tag"}) and bool(names & {"value", "val", "reading"})
        return (2 if has_time else 0) + (2 if long else 0) + (1 if "telem" in t["name"] else 0) + min(t["rows"], 10**7) / 10**7

    def score_cmd(t: dict[str, Any]) -> float:
        names = {c["name"].lower() for c in t["columns"]}
        return (2 if names & {"command", "cmd", "opcode"} else 0) + (1 if "cmd" in t["name"] or "command" in t["name"] else 0)

    tel = max(tables, key=score_tel, default=None)
    cmd = max(tables, key=score_cmd, default=None)
    return {"telemetry": tel["name"] if tel else None,
            "commands": cmd["name"] if cmd and score_cmd(cmd) > 0 else None}


def _guess_columns(columns: list[dict[str, Any]]) -> dict[str, Any]:
    names = [c["name"] for c in columns]
    lower = {n.lower(): n for n in names}
    time_col = next((c["name"] for c in columns if "timestamp" in c["type"]), None) \
        or next((lower[k] for k in ("ts", "time", "timestamp", "time_s", "t", "sent_at") if k in lower), names[0] if names else None)
    channel_col = next((lower[k] for k in ("channel", "name", "signal", "metric", "tag") if k in lower), None)
    value_col = next((lower[k] for k in ("value", "val", "reading", "value_num") if k in lower), None)
    text_col = next((lower[k] for k in ("value_text", "text", "state", "str_value") if k in lower), None)
    command_col = next((lower[k] for k in ("command", "cmd", "opcode", "name") if k in lower), None)
    layout = "long" if channel_col and value_col else "wide"
    return {"layout": layout, "time_col": time_col, "channel_col": channel_col, "value_col": value_col,
            "text_col": text_col, "command_col": command_col}


def pg_inspect(url: str, table: str) -> dict[str, Any]:
    with psycopg.connect(url, connect_timeout=4) as conn:
        cols = conn.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position", (table,)
        ).fetchall()
        columns = [{"name": c, "type": t} for c, t in cols]
        with conn.cursor() as cur:
            cur.execute(sql.SQL("SELECT * FROM {} LIMIT 8").format(sql.Identifier(table)))
            preview = [[_cell(v) for v in row] for row in cur.fetchall()]
    return {"table": table, "columns": columns, "preview": preview, "guess": _guess_columns(columns)}


def _cell(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, float):
        return round(v, 4)
    return v


def pg_channel_stats(url: str, table: str, layout: str, time_col: str, channel_col: str | None,
                     value_col: str | None, text_col: str | None) -> list[dict[str, Any]]:
    """One row per source channel: count, range, median, a sample text value."""
    with psycopg.connect(url, connect_timeout=4) as conn:
        if layout == "long":
            parts = [sql.SQL("{c} AS name, count(*) AS n, min({v}) AS lo, max({v}) AS hi, "
                             "percentile_cont(0.5) WITHIN GROUP (ORDER BY {v}) AS med").format(
                c=sql.Identifier(channel_col), v=sql.Identifier(value_col))]
            parts.append(sql.SQL(", min({t}) AS sample_text").format(t=sql.Identifier(text_col)) if text_col else sql.SQL(", NULL AS sample_text"))
            q = sql.SQL("SELECT {} FROM {} GROUP BY 1 ORDER BY 1").format(sql.Composed(parts), sql.Identifier(table))
            rows = conn.execute(q).fetchall()
            return [{"name": r[0], "count": int(r[1]), "min": _f(r[2]), "max": _f(r[3]), "median": _f(r[4]), "sample_text": r[5]} for r in rows]
        cols = conn.execute(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=%s", (table,)
        ).fetchall()
        out = []
        for c, t in cols:
            if c == time_col:
                continue
            if t in ("double precision", "real", "numeric", "integer", "bigint", "smallint"):
                r = conn.execute(sql.SQL("SELECT count({c}), min({c}), max({c}), percentile_cont(0.5) WITHIN GROUP (ORDER BY {c}) FROM {t}").format(
                    c=sql.Identifier(c), t=sql.Identifier(table))).fetchone()
                out.append({"name": c, "count": int(r[0]), "min": _f(r[1]), "max": _f(r[2]), "median": _f(r[3]), "sample_text": None})
            else:
                r = conn.execute(sql.SQL("SELECT count({c}), min({c}) FROM {t}").format(c=sql.Identifier(c), t=sql.Identifier(table))).fetchone()
                out.append({"name": c, "count": int(r[0]), "min": None, "max": None, "median": None, "sample_text": r[1]})
        return out


def _f(v: Any) -> float | None:
    return None if v is None else round(float(v), 4)


def suggest_channels(stats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For each ORBIT channel: best source match, a unit scale if the numbers say so, and why."""
    spec = load_and_validate()
    out = []
    used: set[str] = set()
    for orbit, meta in spec["channels"].items():
        best, best_score = None, 0.0
        for s in stats:
            n = s["name"].lower()
            score = 0.0
            for a in ALIASES.get(orbit, []):
                if n == a:
                    score = max(score, 1.0)
                elif n.startswith(a) or a in n:
                    score = max(score, 0.75)
            if score > best_score and s["name"] not in used:
                best, best_score = s, score
        entry: dict[str, Any] = {"orbit": orbit, "unit": meta.get("unit"), "source": None, "scale": 1.0,
                                 "confidence": "none", "note": "No likely match. Pick one or leave unmapped."}
        if best:
            used.add(best["name"])
            entry.update(source=best["name"], confidence="high" if best_score >= 1 else "medium",
                         note="Name matches" if best_score >= 1 else "Name is similar")
            entry.update(_unit_check(orbit, meta, best))
        out.append(entry)
    extra = [s["name"] for s in stats if s["name"] not in used]
    return [*out, *([{"orbit": None, "unused": extra}] if extra else [])]


def _unit_check(orbit: str, meta: dict[str, Any], s: dict[str, Any]) -> dict[str, Any]:
    if orbit == "PAY.mode" or s.get("median") is None:
        return {"range": s.get("sample_text")}
    lo, hi = (meta.get("nominal_range") or [None, None])
    ceiling = max(v for v in (hi, meta.get("critical_limit"), meta.get("warn_limit")) if v is not None)
    observed_hi = s["max"]
    out: dict[str, Any] = {"range": f"{s['min']:g} to {s['max']:g}"}
    if observed_hi is not None and ceiling and observed_hi > 20 * ceiling and observed_hi / 1000 <= 3 * ceiling:
        out.update(scale=0.001, unit_note=f"Values run up to {observed_hi:g}, about 1000× what ORBIT expects in {meta.get('unit')}. Looks like milli-units, so ORBIT will divide by 1000.")
        out["confidence"] = "check"
    return out


def suggest_commands(names_counts: list[tuple[str, int]]) -> list[dict[str, Any]]:
    out = []
    for name, n in names_counts:
        match = next((orbit for orbit, aliases in COMMAND_ALIASES.items() if name.upper() in aliases), None)
        out.append({"name": name, "count": int(n), "orbit": match,
                    "meaning": ORBIT_COMMANDS.get(match) if match else None})
    out.sort(key=lambda c: (c["orbit"] is None, -c["count"]))
    return out


def pg_command_names(url: str, table: str, command_col: str) -> list[tuple[str, int]]:
    with psycopg.connect(url, connect_timeout=4) as conn:
        q = sql.SQL("SELECT {c}, count(*) FROM {t} GROUP BY 1 ORDER BY 2 DESC").format(
            c=sql.Identifier(command_col), t=sql.Identifier(table))
        return [(r[0], r[1]) for r in conn.execute(q).fetchall()]


# ── CSV upload path ──────────────────────────────────────────────────────────

def save_upload(role: str, body: bytes) -> dict[str, Any]:
    if role not in ("telemetry", "commands"):
        raise ValueError("role must be telemetry or commands")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path = UPLOAD_DIR / f"{role}.csv"
    path.write_bytes(body)
    df = pd.read_csv(path, nrows=2000)
    columns = [{"name": c, "type": "timestamp" if _looks_time(df[c]) else ("double precision" if pd.api.types.is_numeric_dtype(df[c]) else "text")}
               for c in df.columns]
    return {"role": role, "path": str(path), "columns": columns, "guess": _guess_columns(columns),
            "preview": df.head(8).round(4).astype(object).where(df.head(8).notna(), None).values.tolist(),
            "rows": sum(1 for _ in path.open()) - 1}


def _looks_time(col: pd.Series) -> bool:
    if col.dtype != object:
        return False
    try:
        pd.to_datetime(col.dropna().head(20), utc=True)
        return True
    except (ValueError, TypeError):
        return False


def csv_channel_stats(path: str, layout: str, time_col: str, channel_col: str | None, value_col: str | None,
                      text_col: str | None) -> list[dict[str, Any]]:
    df = pd.read_csv(path)
    if layout == "long":
        df = _pivot_long(df, time_col, channel_col, value_col, text_col).drop(columns="__ts")
    else:
        df = df.drop(columns=[time_col])
    out = []
    for c in df.columns:
        col = df[c]
        if pd.api.types.is_numeric_dtype(col):
            out.append({"name": c, "count": int(col.notna().sum()), "min": _f(col.min()), "max": _f(col.max()),
                        "median": _f(col.median()), "sample_text": None})
        else:
            out.append({"name": c, "count": int(col.notna().sum()), "min": None, "max": None, "median": None,
                        "sample_text": str(col.dropna().iloc[0]) if col.notna().any() else None})
    return out


def csv_command_names(path: str, command_col: str) -> list[tuple[str, int]]:
    return list(pd.read_csv(path)[command_col].value_counts().items())
