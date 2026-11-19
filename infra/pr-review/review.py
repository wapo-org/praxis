"""Build short GitHub comments from verified findings and development observations."""

from __future__ import annotations

import re
from typing import Any

from diff_index import DiffIndex
from gates import STATUS_FAILED, any_gate_failed
from rules import is_hard
from visual_review import VISUAL_SCORE_MAX, VisualAssessment, access_request, artifact_notes, public_text

VERDICT_COMMENT = "COMMENT"
VERDICT_REQUEST_CHANGES = "REQUEST_CHANGES"
FINDING_MARKER_PREFIX = "<!-- muse-finding:"
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
GATE_SNIPPET_MAX_CHARS = 700
GATE_SNIPPET_MAX_LINES = 14
CODE_REVIEW_SESSIONS = ("abstractions", "maintainability", "conciseness", "logic_bs", "security")


def _clean_gate_snippet(output_tail: str) -> str:
    cleaned = ANSI_ESCAPE.sub("", output_tail or "").strip()
    lines = [line.rstrip() for line in cleaned.splitlines() if line.strip()]
    snippet = "\n".join(lines[-GATE_SNIPPET_MAX_LINES:])
    return snippet[-GATE_SNIPPET_MAX_CHARS:].strip()


def _format_run_summary(
    *,
    head_sha: str,
    reviewed_file_count: int | None,
    session_summaries: dict[str, str],
) -> str | None:
    if reviewed_file_count is None and not session_summaries:
        return None
    short_sha = head_sha[:7] if head_sha else "HEAD"
    count_label = ""
    if reviewed_file_count is not None:
        noun = "file" if reviewed_file_count == 1 else "files"
        count_label = f" · Reviewed {reviewed_file_count} {noun}"
    lines = [f"**Review `{short_sha}`**{count_label}"]
    if session_summaries:
        lines.append("")
        for key in CODE_REVIEW_SESSIONS:
            if key in session_summaries:
                lines.append(f"- `{key}`: {session_summaries[key]}")
    return "\n".join(lines)


def finding_marker(rule_id: str) -> str:
    return f"{FINDING_MARKER_PREFIX}{rule_id} -->"


def is_blocking_finding(finding: dict[str, Any]) -> bool:
    return is_hard(finding["rule_id"]) and finding.get("confidence") == "high"


def blocking_reasons(gates: list[dict[str, Any]], findings: list[dict[str, Any]]) -> list[str]:
    reasons = [f"gate `{gate['key']}` failed" for gate in gates if gate.get("status") == STATUS_FAILED]
    reasons.extend(
        f"`{finding['rule_id']}` at `{finding['file']}:{finding['line']}`"
        for finding in findings
        if is_blocking_finding(finding)
    )
    return reasons


def decide_verdict(gates: list[dict[str, Any]], findings: list[dict[str, Any]]) -> str:
    if any_gate_failed(gates) or any(is_blocking_finding(finding) for finding in findings):
        return VERDICT_REQUEST_CHANGES
    return VERDICT_COMMENT


def format_finding(finding: dict[str, Any]) -> str:
    rule_id = finding["rule_id"]
    label = "Hard boundary" if is_blocking_finding(finding) else "Question / offer"
    parts = [f"**{label} · `{rule_id}`**", public_text(finding["failure_scenario"])]
    if finding.get("suggestion"):
        parts.append(public_text(finding["suggestion"]))
    if finding.get("linear_issue"):
        parts.append(f"Linear issue `{finding['linear_issue']}`.")
    parts.append(finding_marker(rule_id))
    return "\n\n".join(parts)


def format_gate_finding(finding: dict[str, Any]) -> str:
    location = f"{finding['file']}:{finding['line']}"
    return f"**`{finding['rule_id']}` at `{location}`**\n\n{finding['message']}\n\n{finding_marker(finding['rule_id'])}"


def build_review(
    *,
    gates: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    hands_on: dict[str, Any] | None,
    diff: DiffIndex,
    visual: VisualAssessment | None = None,
    run_id: str | None = None,
    head_sha: str = "",
    reviewed_file_count: int | None = None,
    session_summaries: dict[str, str] | None = None,
) -> dict[str, Any]:
    verdict = decide_verdict(gates, findings)
    comments: list[dict[str, Any]] = []
    notes: list[str] = []
    for gate in gates:
        for finding in gate["findings"]:
            message = format_gate_finding(finding)
            if diff.has_line(finding["file"], finding["line"]):
                comments.append(_inline(finding["file"], finding["line"], message))
            else:
                notes.append(message)
        if gate.get("status") == STATUS_FAILED and not gate["findings"]:
            snippet = _clean_gate_snippet(str(gate.get("output_tail") or ""))
            detail = f"\n\n```text\n{snippet}\n```" if snippet else ""
            notes.append(f"**Required check failed**\n\n`{gate['key']}` exited with code {gate['exit_code']}.{detail}")
    for finding in findings:
        comments.append(_inline(finding["file"], finding["line"], format_finding(finding)))

    if visual is not None:
        notes.append(f"**Development UI/UX score {visual.score}/{VISUAL_SCORE_MAX}** based on the captured contact sheet.")
        notes.extend(f"**{view}**\n\n{issue}" for view, issue in visual.inconsistencies)
        notes.extend(artifact_notes(visual, run_id=run_id))
    if request := access_request(hands_on):
        notes.append(request)

    summary_note = _format_run_summary(
        head_sha=head_sha,
        reviewed_file_count=reviewed_file_count,
        session_summaries=session_summaries or {},
    )
    if summary_note:
        notes.insert(0, summary_note)

    body = ""
    if verdict == VERDICT_REQUEST_CHANGES:
        body = "Changes requested for the verified issues listed separately."
    elif comments:
        body = "See the findings on the changed lines."
    return {
        "verdict": verdict,
        "body": body,
        "comments": comments,
        "notes": notes,
        "blocking_reasons": blocking_reasons(gates, findings),
    }


def _inline(path: str, line: int, body: str) -> dict[str, Any]:
    return {"path": path, "line": line, "side": "RIGHT", "body": body}


def unanchored_comment(comment: dict[str, Any]) -> str:
    return f"`{comment['path']}:{comment['line']}`\n\n{comment['body']}"
