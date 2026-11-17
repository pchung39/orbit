"""Connectors read a team's database or CSV into ORBIT's terms, and suggest mappings honestly.

python -m unittest storage.test_connectors -v
Database tests need the dummy team database (python -m storage.archive_seed) and skip without it.
"""

from __future__ import annotations

import unittest

import numpy as np

from storage import connectors as C
from storage.archive_seed import DEMO_URL, demo_ready


def _demo_config() -> C.SourceConfig:
    stats = C.pg_channel_stats(DEMO_URL, "telemetry", "long", "ts", "channel", "value", "value_text")
    chans = {s["orbit"]: {"source": s["source"], "scale": s["scale"]}
             for s in C.suggest_channels(stats) if s.get("orbit") and s.get("source")}
    cmd_map = {c["name"]: c["orbit"] for c in C.suggest_commands(C.pg_command_names(DEMO_URL, "command_log", "command")) if c["orbit"]}
    return C.SourceConfig(kind="postgres", name="demo", url=DEMO_URL, layout="long", table="telemetry",
                          time_col="ts", channel_col="channel", value_col="value", text_col="value_text",
                          channels=chans, commands={"table": "command_log", "time_col": "sent_at",
                                                    "command_col": "command", "map": cmd_map}, synthetic=True)


@unittest.skipUnless(demo_ready(), "dummy team database not seeded (python -m storage.archive_seed)")
class DatabaseTests(unittest.TestCase):
    def test_connection_report(self) -> None:
        r = C.pg_test(DEMO_URL)
        self.assertTrue(r["ok"])
        self.assertTrue(r["read_only"])
        self.assertEqual(r["guess"], {"telemetry": "telemetry", "commands": "command_log"})

    def test_wrong_password_is_plain_english(self) -> None:
        r = C.pg_test(DEMO_URL.replace(":readonly@", ":nope@"))
        self.assertFalse(r["ok"])
        self.assertIn("username or password", r["error"])

    def test_layout_and_columns_guessed(self) -> None:
        g = C.pg_inspect(DEMO_URL, "telemetry")["guess"]
        self.assertEqual((g["layout"], g["time_col"], g["channel_col"], g["value_col"], g["text_col"]),
                         ("long", "ts", "channel", "value", "value_text"))

    def test_suggestions_catch_names_and_milliamps(self) -> None:
        stats = C.pg_channel_stats(DEMO_URL, "telemetry", "long", "ts", "channel", "value", "value_text")
        sugg = {s["orbit"]: s for s in C.suggest_channels(stats) if s.get("orbit")}
        self.assertEqual(sugg["EPS.bus_voltage"]["source"], "eps_bus_v")
        self.assertEqual(sugg["PAY.payload_current"]["source"], "pl_i_ma")
        self.assertEqual(sugg["PAY.payload_current"]["scale"], 0.001)
        unused = next(s for s in C.suggest_channels(stats) if s.get("unused"))["unused"]
        self.assertEqual(sorted(unused), ["adcs_rate_x", "rx_rssi_dbm"])

    def test_commands_mapped_and_unknown_left_alone(self) -> None:
        cmds = {c["name"]: c["orbit"] for c in C.suggest_commands(C.pg_command_names(DEMO_URL, "command_log", "command"))}
        self.assertEqual(cmds["HTR_B_ON"], "HEATER_B_ENABLE")
        self.assertEqual(cmds["PL_MODE_STBY"], "PAYLOAD_STANDBY")
        self.assertIsNone(cmds["PL_RST"])

    def test_database_history_matches_csv_history(self) -> None:
        """Same mission through either door: identical numbers in ORBIT's units."""
        db_tel, db_cmd, _ = C.load_history(_demo_config())
        csv_tel, csv_cmd, _ = C.load_history(C.dummy_csv_config())
        self.assertEqual(len(db_tel), len(csv_tel))
        for ch in ("EPS.bus_voltage", "EPS.battery_current", "PAY.payload_current", "THM.heater_b_current"):
            with self.subTest(channel=ch):
                np.testing.assert_allclose(db_tel[ch].to_numpy(), csv_tel[ch].to_numpy(), atol=1e-6)
        self.assertTrue((db_tel["PAY.mode"].to_numpy() == csv_tel["PAY.mode"].to_numpy()).all())
        self.assertEqual(db_cmd["command"].value_counts().to_dict(), csv_cmd["command"].value_counts().to_dict())


class MaskingTests(unittest.TestCase):
    def test_password_masked(self) -> None:
        self.assertEqual(C.masked("postgresql://u:secret@h:5432/db"), "postgresql://u:•••@h:5432/db")


if __name__ == "__main__":
    unittest.main()
