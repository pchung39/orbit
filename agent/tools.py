"""Agent tools: the only way the investigator is allowed to see the world.

Each call is logged so a report can show that numbers came from Postgres,
not from a canned narrative. Telemetry/events are OBSERVED. Documents are
DOCUMENTED. Ratios and limit checks are computed in the investigator (DERIVED).
"""

from __future__ import annotations

from typing import Any

import psycopg

from agent.tracing import log_to_span, span
from simulator.scenarios import clock_to_s, format_clock
from storage.store import get_document, query_channel, query_events, search_documents


class Tools:
    def __init__(self, conn: psycopg.Connection, spec: dict[str, Any]):
        self.conn = conn
        self.spec = spec
        self.log: list[str] = []

    def _note(self, msg: str) -> None:
        self.log.append(msg)

    def sample(self, run_id: str, channel: str, time_s: float) -> dict[str, Any] | None:
        with span(
            "sample",
            span_type="tool",
            input={"run_id": run_id, "channel": channel, "clock": format_clock(time_s)},
        ) as sp:
            rows = query_channel(self.conn, run_id, channel, time_s - 5, time_s + 5)
            if not rows:
                self._note(f"sample {run_id} {channel} @ {format_clock(time_s)} → none")
                log_to_span(sp, output=None)
                return None
            row = min(rows, key=lambda r: abs(r["time_s"] - time_s))
            self._note(
                f"sample {run_id} {channel} @ {format_clock(time_s)} "
                f"→ {format_clock(row['time_s'])} {_fmt(row)}"
            )
            out = public_row(row)
            log_to_span(sp, output=out)
            return row

    def first_warn(self, run_id: str, channel: str) -> dict[str, Any] | None:
        with span(
            "first_warn",
            span_type="tool",
            input={"run_id": run_id, "channel": channel},
        ) as sp:
            meta = self.spec["channels"][channel]
            limit = meta.get("warn_limit")
            direction = meta.get("limit_direction")
            rows = query_channel(self.conn, run_id, channel)
            hit = None
            for row in rows:
                value = row["value_num"]
                if value is None or limit is None:
                    continue
                if direction == "below" and value < limit:
                    hit = row
                    break
                if direction == "above" and value > limit:
                    hit = row
                    break
            self._note(
                f"first_warn {run_id} {channel} limit={limit} {direction} "
                f"→ {format_clock(hit['time_s']) + ' ' + _fmt(hit) if hit else 'none'}"
            )
            log_to_span(sp, output=public_row(hit))
            return hit

    def events_before(self, run_id: str, deadline_s: float, window_s: float = 600.0) -> list[dict[str, Any]]:
        with span(
            "events_before",
            span_type="tool",
            input={
                "run_id": run_id,
                "deadline": format_clock(deadline_s),
                "window_s": window_s,
            },
        ) as sp:
            rows = [
                row
                for row in query_events(self.conn, run_id)
                if deadline_s - window_s <= row["time_s"] <= deadline_s
            ]
            self._note(
                f"events {run_id} in {format_clock(deadline_s - window_s)}–{format_clock(deadline_s)} "
                f"→ {len(rows)}"
            )
            log_to_span(sp, output={"count": len(rows), "events": [public_event(r) for r in rows[:20]]})
            return rows

    def get_doc(self, doc_id: str) -> dict[str, Any] | None:
        with span("get_doc", span_type="tool", input={"doc_id": doc_id}) as sp:
            row = get_document(self.conn, doc_id)
            self._note(f"get_doc {doc_id} → {'hit' if row else 'miss'}")
            if row is None:
                log_to_span(sp, output=None)
            else:
                log_to_span(
                    sp,
                    output={"id": row.get("id"), "kind": row.get("kind"), "title": row.get("title")},
                )
            return row

    def search_docs(self, query: str) -> list[dict[str, Any]]:
        with span("search_docs", span_type="tool", input={"query": query}) as sp:
            rows = search_documents(self.conn, query)
            shown = []
            for row in rows:
                score = row.get("score")
                shown.append(f"{row['id']}" + (f":{float(score):.2f}" if score is not None else ""))
            self._note(f"search_docs {query!r} → {shown}")
            log_to_span(sp, output={"hits": shown})
            return rows

    def sample_at_clock(self, run_id: str, channel: str, clock: str) -> dict[str, Any] | None:
        return self.sample(run_id, channel, clock_to_s(clock))

    def events_before_clock(
        self, run_id: str, deadline_clock: str, window_s: float = 600.0
    ) -> list[dict[str, Any]]:
        return self.events_before(run_id, clock_to_s(deadline_clock), window_s=window_s)

    def channel_meta(self, channel: str) -> dict[str, Any]:
        with span("channel_meta", span_type="tool", input={"channel": channel}) as sp:
            meta = self.spec["channels"][channel]
            out = {
                "channel": channel,
                "unit": meta.get("unit"),
                "nominal_range": meta.get("nominal_range"),
                "warn_limit": meta.get("warn_limit"),
                "critical_limit": meta.get("critical_limit"),
                "limit_direction": meta.get("limit_direction"),
            }
            self._note(f"channel_meta {channel} → warn={out['warn_limit']}")
            log_to_span(sp, output=out)
            return out


def public_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "clock": format_clock(row["time_s"]),
        "time_s": row["time_s"],
        "value_num": row["value_num"],
        "value_text": row["value_text"],
    }


def public_event(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "clock": format_clock(row["time_s"]),
        "event_type": row["event_type"],
        "channel": row["channel"],
        "detail": row["detail"],
    }


def _fmt(row: dict[str, Any]) -> str:
    if row.get("value_text") is not None:
        return str(row["value_text"])
    value = row.get("value_num")
    return f"{value:.3f}" if value is not None else "n/a"
