"""Turn a rules investigation into a filed library close-out.

ORBIT still does not command the spacecraft. Filing records the decision.
"""

from __future__ import annotations

from typing import Any


def _feedback_section(feedback: dict[str, Any]) -> list[str]:
    key = feedback.get("hypothesis_key") or "UNKNOWN"
    if key == "WITHHELD":
        note = (feedback.get("note") or "").strip()
        line = (
            "No root-cause hypothesis asserted — EPS-17 step 4 threshold not met. "
            "**[DOCUMENTED]**"
        )
        if note:
            line = f"{line} Operator note: {note} **[OBSERVED — operator]**"
        return ["## Operator review", "", line, ""]
    verdict = feedback.get("verdict") or ""
    note = (feedback.get("note") or "").strip()
    if verdict == "confirmed":
        line = f"**{key}** — confirmed by operator."
    elif verdict == "rejected":
        line = f"**{key}** — rejected (disagrees with report hypothesis)."
    else:
        line = f"**{key}** — operator review recorded."
    if note:
        line = f"{line} {note}"
    line = f"{line} **[OBSERVED — operator]**"
    return ["## Operator hypothesis review", "", line, ""]


def build_closeout(
    incident: dict[str, Any],
    report: str,
    note: str | None = None,
    feedback: dict[str, Any] | None = None,
) -> str:
    body = report.split("\n## Tool log")[0].rstrip()
    title = incident.get("title") or incident["id"]
    remark = (note or "").strip()
    proc = "EPS-17"
    for line in report.splitlines():
        if "**Procedure:**" in line:
            proc = line.split("**Procedure:**", 1)[-1].strip()
            break
    lines = [
        f"# {incident['id']} — {title}",
        "",
        "| | |",
        "|---|---|",
        f"| ID | {incident['id']} |",
        "| Mission | Aurora-1 |",
        "| Status | filed — recommended action not sent |",
        f"| Entry | `{incident['alarm']}` |",
        f"| Tape | `{incident['run_id']}` |",
        f"| Procedure used | {proc} |",
        "",
        "This is a library close-out. ORBIT recommended a human decision and stopped. "
        "It did not uplink a command.",
        "",
    ]
    if remark:
        lines += [
            "## Operator remark",
            "",
            f"{remark} **[OBSERVED — operator]**",
            "",
        ]
    if feedback:
        lines += _feedback_section(feedback)
    lines += [body, ""]
    return "\n".join(lines)
