"""Turn a rules investigation into a filed library close-out.

ORBIT still does not command the spacecraft. Filing records the decision.
"""

from __future__ import annotations

import json
from typing import Any


def _feedback_section(feedback: dict[str, Any]) -> list[str]:
    key = feedback.get("hypothesis_key") or "UNKNOWN"
    if key == "WITHHELD":
        note = (feedback.get("note") or "").strip()
        verdict = feedback.get("verdict") or ""
        if verdict == "confirmed":
            line = (
                "Hold — do not command — confirmed by operator. "
                "EPS-17 step 4 threshold not met; no root-cause hypothesis asserted. "
                "**[DOCUMENTED]**"
            )
        elif verdict == "rejected":
            line = (
                "Hold — do not command — rejected by operator; "
                "operator disagrees with withholding. "
                "**[OBSERVED — operator]**"
            )
        else:
            line = (
                "No root-cause hypothesis asserted — EPS-17 step 4 threshold not met. "
                "**[DOCUMENTED]**"
            )
        if note:
            line = f"{line} Operator note: {note} **[OBSERVED — operator]**"
        return ["## Operator decision review", "", line, ""]
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


def _decision_section(incident: dict[str, Any]) -> list[str]:
    verify = incident.get("verify_result")
    if isinstance(verify, str):
        try:
            verify = json.loads(verify)
        except ValueError:
            verify = None
    if not incident.get("decision") or not verify:
        return []
    lines = ["## Decision and verification", ""]
    label = verify.get("label") or incident["decision"]
    who = "ORBIT's recommendation" if verify.get("recommended") else "an alternative to ORBIT's recommendation"
    lines.append(f"Operator approved **{label}**, {who}. **[OBSERVED — operator]**")
    if incident.get("decision_note"):
        lines.append(f"Reason: {incident['decision_note']} **[OBSERVED — operator]**")
    if verify.get("simulated"):
        lines.append(
            f"Simulated from {verify.get('decision_clock')}: {verify.get('text')} **[SIMULATED]**"
        )
        if verify.get("step"):
            lines.append(f"{verify['step']} **[DOCUMENTED]**")
    else:
        lines.append(f"{verify.get('text')} **[OBSERVED]**")
    lines.append("")
    return lines


def _procedure_for_closeout(incident: dict[str, Any], report: str) -> str:
    for line in report.splitlines():
        if "**Procedure:**" in line:
            return line.split("**Procedure:**", 1)[-1].strip()
    alarm = incident.get("alarm") or ""
    if alarm == "PAY.payload_current":
        return "PAY-04"
    if alarm == "EPS.battery_voltage":
        return "EPS-09"
    return "EPS-17"


def build_closeout(
    incident: dict[str, Any],
    report: str,
    note: str | None = None,
    feedback: dict[str, Any] | None = None,
) -> str:
    body = report.split("\n## Tool log")[0].rstrip()
    title = incident.get("title") or incident["id"]
    remark = (note or "").strip()
    proc = _procedure_for_closeout(incident, report)
    lines = [
        f"# {incident['id']} — {title}",
        "",
        "| | |",
        "|---|---|",
        f"| ID | {incident['id']} |",
        "| Mission | Aurora-1 |",
        "| Status | filed — no command sent by ORBIT |",
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
    lines += _decision_section(incident)
    if feedback and not incident.get("decision"):
        lines += _feedback_section(feedback)
    lines += [body, ""]
    return "\n".join(lines)
