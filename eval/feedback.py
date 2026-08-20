"""Operator hypothesis feedback — adoption metrics for future eval."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from agent.hypothesis import family_matches_root_cause, hypothesis_for
from eval.cases import CASES, Case
from storage.store import connect, init_schema, list_hypothesis_feedback

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXPORT = Path(__file__).resolve().parent / "feedback.jsonl"


@dataclass(frozen=True)
class FeedbackRow:
    incident_id: str
    run_id: str
    alarm: str
    hypothesis_key: str
    verdict: str
    note: str | None
    updated_at: str
    eval_case: Case | None
    family: str
    aligned: bool | None


def _case_for_run(run_id: str) -> Case | None:
    for case in CASES:
        if case.id == run_id:
            return case
    return None


def load_feedback_rows() -> list[FeedbackRow]:
    conn = connect()
    init_schema(conn)
    raw = list_hypothesis_feedback(conn)
    rows: list[FeedbackRow] = []
    for item in raw:
        case = _case_for_run(item["run_id"])
        family = hypothesis_for(item["run_id"], item["alarm"]).family
        aligned: bool | None = None
        if case:
            matches = family_matches_root_cause(family, case.root_cause)
            if item["verdict"] == "confirmed":
                aligned = matches
            else:
                aligned = not matches
        rows.append(
            FeedbackRow(
                incident_id=item["incident_id"],
                run_id=item["run_id"],
                alarm=item["alarm"],
                hypothesis_key=item["hypothesis_key"],
                verdict=item["verdict"],
                note=item.get("note"),
                updated_at=item["updated_at"],
                eval_case=case,
                family=family,
                aligned=aligned,
            )
        )
    return rows


@dataclass(frozen=True)
class FeedbackSummary:
    total: int
    confirmed: int
    rejected: int
    with_eval_case: int
    aligned: int
    misaligned: int
    unknown: int


def summarize(rows: list[FeedbackRow]) -> FeedbackSummary:
    confirmed = sum(1 for r in rows if r.verdict == "confirmed")
    rejected = sum(1 for r in rows if r.verdict == "rejected")
    with_eval = [r for r in rows if r.eval_case is not None]
    aligned = sum(1 for r in with_eval if r.aligned is True)
    misaligned = sum(1 for r in with_eval if r.aligned is False)
    unknown = len(rows) - len(with_eval)
    return FeedbackSummary(
        total=len(rows),
        confirmed=confirmed,
        rejected=rejected,
        with_eval_case=len(with_eval),
        aligned=aligned,
        misaligned=misaligned,
        unknown=unknown,
    )


def print_summary(rows: list[FeedbackRow]) -> None:
    summary = summarize(rows)
    print(f"feedback rows: {summary.total}")
    print(f"  confirmed: {summary.confirmed}  rejected: {summary.rejected}")
    print(f"  eval-mapped: {summary.with_eval_case}  aligned: {summary.aligned}  misaligned: {summary.misaligned}")
    if summary.unknown:
        print(f"  no eval case: {summary.unknown}")
    print()
    for row in rows:
        case_label = row.eval_case.label if row.eval_case else "—"
        align = "aligned" if row.aligned is True else "misaligned" if row.aligned is False else "—"
        print(
            f"{row.incident_id:10} {row.run_id:8} {row.verdict:9} {row.hypothesis_key:32} {align:11} {case_label}"
        )


def export_jsonl(rows: list[FeedbackRow], path: Path = DEFAULT_EXPORT) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(
                json.dumps(
                    {
                        "incident_id": row.incident_id,
                        "run_id": row.run_id,
                        "alarm": row.alarm,
                        "hypothesis_key": row.hypothesis_key,
                        "verdict": row.verdict,
                        "note": row.note,
                        "updated_at": row.updated_at,
                        "family": row.family,
                        "eval_case_id": row.eval_case.id if row.eval_case else None,
                        "aligned": row.aligned,
                    }
                )
                + "\n"
            )
    return path
