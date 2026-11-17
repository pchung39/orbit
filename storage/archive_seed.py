"""Seed a dummy "team database" for the connector to talk to.

Same dummy mission history, but shaped the way a small team's own archive
might be: their channel names, one row per sample (the usual time-series
layout), payload current stored in milliamps, a couple of channels ORBIT
doesn't use, an unrelated table, and a read-only login.

python -m storage.archive_seed       # creates database aurora_archive on the local Postgres
"""

from __future__ import annotations

import io
import os

import numpy as np
import pandas as pd
import psycopg

from simulator import mission

ADMIN_URL = os.environ.get("DATABASE_URL", "postgresql://orbit:orbit@localhost:5432/orbit")
ARCHIVE_DB = "aurora_archive"
READER, READER_PW = "orbit_reader", "readonly"
DEMO_URL = f"postgresql://{READER}:{READER_PW}@localhost:5432/{ARCHIVE_DB}"

# Their names for ORBIT's channels (and a unit surprise on payload current).
THEIR_NAMES = {
    "EPS.bus_voltage": "eps_bus_v",
    "EPS.bus_current": "eps_bus_i",
    "EPS.battery_voltage": "bat_v",
    "EPS.battery_current": "bat_i",
    "EPS.solar_array_current": "sa_i",
    "THM.battery_temperature": "bat_temp",
    "THM.heater_b_temperature": "htr_b_temp",
    "THM.heater_b_current": "htr_b_i",
    "PAY.power_draw": "pl_pwr",
    "PAY.payload_current": "pl_i_ma",
    "PAY.mode": "pl_mode",
}
SCALE_TO_THEIRS = {"PAY.payload_current": 1000.0}
THEIR_COMMANDS = {
    "HEATER_B_ENABLE": "HTR_B_ON",
    "HEATER_B_DISABLE": "HTR_B_OFF",
    "SCIENCE_MODE": "PL_MODE_SCI",
    "PAYLOAD_STANDBY": "PL_MODE_STBY",
}


def _admin_url_for(db: str) -> str:
    base, _, _ = ADMIN_URL.rpartition("/")
    return f"{base}/{db}"


def seed(verbose: bool = True) -> str:
    mission.ensure_mission()
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (ARCHIVE_DB,)).fetchone():
            conn.execute(f"CREATE DATABASE {ARCHIVE_DB} TEMPLATE template0")
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (READER,)).fetchone():
            conn.execute(f"CREATE ROLE {READER} LOGIN PASSWORD '{READER_PW}'")

    tel = pd.read_csv(mission.TELEMETRY_CSV)
    cmds = pd.read_csv(mission.COMMANDS_CSV)
    rng = np.random.default_rng(11)
    ts = pd.to_datetime(tel["timestamp"], utc=True)

    frames = []
    for orbit_name, their in THEIR_NAMES.items():
        col = tel[orbit_name]
        if orbit_name == "PAY.mode":
            frames.append(pd.DataFrame({"ts": ts, "channel": their, "value": np.nan, "value_text": col}))
        else:
            frames.append(pd.DataFrame({"ts": ts, "channel": their,
                                        "value": col * SCALE_TO_THEIRS.get(orbit_name, 1.0), "value_text": None}))
    # Channels the team logs that ORBIT has no use for.
    frames.append(pd.DataFrame({"ts": ts, "channel": "adcs_rate_x", "value": rng.normal(0, 0.02, len(ts)), "value_text": None}))
    frames.append(pd.DataFrame({"ts": ts, "channel": "rx_rssi_dbm", "value": rng.normal(-92, 3, len(ts)), "value_text": None}))
    long = pd.concat(frames, ignore_index=True)

    cmd = pd.DataFrame({
        "sent_at": pd.to_datetime(cmds["timestamp"], utc=True),
        "command": cmds["command"].map(lambda c: THEIR_COMMANDS.get(c, c)),
        "operator": "ops",
        "acked": True,
    })

    with psycopg.connect(_admin_url_for(ARCHIVE_DB), autocommit=True) as conn:
        conn.execute("DROP TABLE IF EXISTS telemetry, command_log, ground_passes, dataset_info")
        conn.execute("CREATE TABLE telemetry (ts timestamptz NOT NULL, channel text NOT NULL, value double precision, value_text text)")
        conn.execute("CREATE TABLE command_log (sent_at timestamptz NOT NULL, command text NOT NULL, operator text, acked boolean)")
        conn.execute("CREATE TABLE ground_passes (station text, aos timestamptz, los timestamptz, max_elev_deg real)")
        conn.execute("CREATE TABLE dataset_info (key text PRIMARY KEY, value text)")
        _copy(conn, "telemetry (ts, channel, value, value_text)", long)
        _copy(conn, "command_log (sent_at, command, operator, acked)", cmd)
        passes = pd.DataFrame({
            "station": rng.choice(["SVALBARD", "TROLL", "PUNTA_ARENAS"], 60),
            "aos": ts.iloc[0] + pd.to_timedelta(np.sort(rng.uniform(0, 27 * 86400, 60)), unit="s"),
        })
        passes["los"] = passes["aos"] + pd.to_timedelta(rng.uniform(6, 12, 60), unit="m")
        passes["max_elev_deg"] = rng.uniform(10, 80, 60).round(1)
        _copy(conn, "ground_passes (station, aos, los, max_elev_deg)", passes)
        conn.execute("INSERT INTO dataset_info VALUES ('synthetic', 'true'), ('mission', 'Aurora-1')")
        conn.execute("CREATE INDEX telemetry_channel_ts ON telemetry (channel, ts)")
        conn.execute("CREATE INDEX command_log_sent_at ON command_log (sent_at)")
        conn.execute(f"GRANT CONNECT ON DATABASE {ARCHIVE_DB} TO {READER}")
        conn.execute(f"GRANT USAGE ON SCHEMA public TO {READER}")
        conn.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA public TO {READER}")
        conn.execute("ANALYZE")
    if verbose:
        print(f"seeded {ARCHIVE_DB}: {len(long):,} telemetry rows, {len(cmd)} commands → {DEMO_URL}")
    return DEMO_URL


def _copy(conn: psycopg.Connection, target: str, df: pd.DataFrame) -> None:
    buf = io.StringIO()
    df.to_csv(buf, index=False, header=False, na_rep="\\N")
    buf.seek(0)
    with conn.cursor().copy(f"COPY {target} FROM STDIN WITH (FORMAT csv, NULL '\\N')") as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)


def demo_ready() -> bool:
    try:
        with psycopg.connect(DEMO_URL, connect_timeout=2) as conn:
            return bool(conn.execute("SELECT 1 FROM dataset_info LIMIT 1").fetchone())
    except Exception:
        return False


if __name__ == "__main__":
    seed()
