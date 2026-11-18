"""Build the GitHub review from server-verified data only: gate results and validated findings."""

from __future__ import annotations

import string
from typing import Any

from diff_index import DiffIndex
from gates import STATUS_ERROR, STATUS_FAILED, STATUS_PASSED, STATUS_SKIPPED, any_gate_failed
from rules import is_hard
from validation import SessionValidation

VERDICT_COMMENT = "COMMENT"
VERDICT_REQUEST_CHANGES = "REQUEST_CHANGES"
FINDING_MARKER_PREFIX = "<!-- muse-finding:"
LIVE_CHECK_ITEMS_MAX = 8
LIVE_CHECK_ITEM_CHARS = 160
LIVE_OBSERVATIONS_CHARS = 500
GATE_OUTPUT_IN_BODY_CHARS = 1500

GATE_ICONS = {
    STATUS_PASSED: "✅",
    STATUS_FAILED: "❌",
    STATUS_SKIPPED: "⏭️",
    STATUS_ERROR: "⚠️",
}


def finding_marker(rule_id: str) -> str:
    """Hidden tag that lets the slop report map a GitHub thread back to a rule."""
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
    """Only a failed deterministic gate or a verified high-confidence HARD-rule finding may block."""
    if any_gate_failed(gates) or any(is_blocking_finding(finding) for finding in findings):
        return VERDICT_REQUEST_CHANGES
    return VERDICT_COMMENT


def format_finding(finding: dict[str, Any]) -> str:
    rule_id = finding["rule_id"]
    blocking = is_blocking_finding(finding)
    label = "Hard-boundary flag" if blocking else "Question / offer"
    sessions = ", ".join(finding.get("sessions") or [])
    lines = [
        f"**{label} · `{rule_id}`** · confidence {finding['confidence']} · seen by {sessions}",
        "",
        "```",
        finding["evidence"],
        "```",
        "",
        f"What could go wrong: {finding['failure_scenario']}",
    ]
    if finding.get("suggestion"):
        opener = "Suggested fix" if blocking else "Would it help to consider"
        lines.extend(["", f"{opener}: {finding['suggestion']}"])
    if finding.get("linear_issue") and finding.get("linear_quote"):
        lines.extend(["", f"{finding['linear_issue']} says: “{finding['linear_quote']}”"])
    lines.extend(["", finding_marker(rule_id)])
    return "\n".join(lines)


def format_gate_finding(finding: dict[str, Any]) -> str:
    verbatim = f"{finding['file']}:{finding['line']} {finding['rule_id']} {finding['message']}"
    return f"**check:rules** (deterministic)\n\n`{verbatim}`\n\n{finding_marker(finding['rule_id'])}"


def _gate_lines(gates: list[dict[str, Any]]) -> list[str]:
    lines = ["### Deterministic gates (run by the server, not by the model)"]
    if not gates:
        lines.append("- none ran")
    for gate in gates:
        icon = GATE_ICONS.get(gate["status"], "⚠️")
        detail = f"exit {gate['exit_code']}" if gate["status"] == STATUS_FAILED else gate["status"]
        lines.append(f"- {icon} `{gate['key']}` — {detail}, {gate['duration_seconds']}s")

    for gate in gates:
        if gate["status"] != STATUS_FAILED:
            continue
        tail = gate["output_tail"][-GATE_OUTPUT_IN_BODY_CHARS:].replace("```", "'''")
        lines.extend(["", f"<details><summary>`{gate['key']}` output</summary>", "", "```", tail, "```", "", "</details>"])
    return lines


def _session_lines(sessions: list[SessionValidation], session_errors: dict[str, str]) -> list[str]:
    kept = sum(len(result.kept) for result in sessions)
    dropped = sum(len(result.dropped) for result in sessions)
    lines = [
        "### Model sessions",
        f"- {kept} finding(s) verified against the diff and posted; "
        f"{dropped} dropped by server-side validation (see the slop report).",
    ]
    for session, error in sorted(session_errors.items()):
        lines.append(f"- `{session}` returned no usable output (`{error}`); nothing from it was posted.")
    return lines


def _live_check_lines(hands_on: dict[str, Any] | None) -> list[str]:
    if not isinstance(hands_on, dict):
        return []

    def items(key: str) -> list[str]:
        values = hands_on.get(key)
        if not isinstance(values, list):
            return []
        return [str(value)[:LIVE_CHECK_ITEM_CHARS] for value in values[:LIVE_CHECK_ITEMS_MAX]]

    lines = ["", "<details><summary>Live app checks (model-reported, not verified by the server)</summary>", ""]
    lines.extend(f"- passed: `{item}`" for item in items("checks_passed"))
    lines.extend(f"- failed: `{item}`" for item in items("checks_failed"))
    observations = hands_on.get("manual_observations")
    if isinstance(observations, str) and observations.strip():
        lines.extend(["", observations.strip()[:LIVE_OBSERVATIONS_CHARS]])
    lines.extend(["", "</details>"])
    return lines


def _ui_review_lines(report: dict[str, Any] | None) -> list[str]:
    if report is None:
        return []

    def plain(value: str) -> str:
        return "".join(
            f"&#{ord(char)};" if char in string.punctuation else char
            for char in value.replace("\n", " ").replace("\r", " ")
        )

    lines = ["", "### Vercel UI review"]
    if report["status"] != "reviewed":
        lines.append(f"- {plain(report['reason'])}")
        return lines

    lines.append(f"- Preview: {report['preview']}")
    if report.get("artifacts"):
        lines.append(f"- Recordings and contact sheets: Modal volume `praxis-pr-review-runs/{report['artifacts']}/`")
    for number, flow in enumerate(report["flows"], 1):
        lines.append(f"- **{number}. {plain(flow['title'])}**")
        for label, key in (("Browser", "browser"), ("Visual review", "visual")):
            outcome = flow[key]
            status = outcome["status"].replace("_", " ")
            lines.append(f"  - {label}: **{status}**. {plain(outcome['observation'])}")
        if flow["sheets"]:
            names = ", ".join(f"`{sheet}`" for sheet in flow["sheets"])
            lines.append(f"  - Contact sheets: {names}")
    return lines


def build_review(
    *,
    gates: list[dict[str, Any]],
    sessions: list[SessionValidation],
    findings: list[dict[str, Any]],
    session_errors: dict[str, str],
    hands_on: dict[str, Any] | None,
    diff: DiffIndex,
    model: str,
    ui_review: dict[str, Any] | None = None,
) -> dict[str, Any]:
    verdict = decide_verdict(gates, findings)
    comments: list[dict[str, Any]] = []
    unplaced: list[str] = []

    for gate in gates:
        for finding in gate["findings"]:
            if diff.has_line(finding["file"], finding["line"]):
                comments.append(_inline(finding["file"], finding["line"], format_gate_finding(finding)))
            else:
                unplaced.append(f"- `{finding['file']}:{finding['line']} {finding['rule_id']} {finding['message']}`")
    for finding in findings:
        comments.append(_inline(finding["file"], finding["line"], format_finding(finding)))

    body = [f"## Praxis PR review (`{model}`) — `{verdict.replace('_', ' ')}`", ""]
    reasons = blocking_reasons(gates, findings)
    if reasons:
        body.extend(["**Blocking:** " + "; ".join(reasons), ""])
    body.extend(_gate_lines(gates))
    if unplaced:
        body.extend(["", "`check:rules` findings outside the diff lines:", *unplaced])
    body.extend(["", *_session_lines(sessions, session_errors)])
    body.extend(_live_check_lines(hands_on))
    body.extend(_ui_review_lines(ui_review))

    return {
        "verdict": verdict,
        "body": "\n".join(body).strip(),
        "comments": comments,
        "blocking_reasons": reasons,
    }


def _inline(path: str, line: int, body: str) -> dict[str, Any]:
    return {"path": path, "line": line, "side": "RIGHT", "body": body}


def body_with_inline_comments(review: dict[str, Any]) -> str:
    """Fallback body for when GitHub rejects the inline anchors."""
    parts = [review["body"], "", "### Findings"]
    for comment in review["comments"]:
        parts.extend(["", f"`{comment['path']}:{comment['line']}`", "", comment["body"]])
    return "\n".join(parts)
