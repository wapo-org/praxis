"""Server-side validation of model findings: nothing unverifiable reaches GitHub."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from diff_index import DiffIndex, collapse
from rules import MODEL_RULE_IDS, RULES, SCRIPT_RULE_IDS, SESSION_RULE_IDS

MAX_FINDINGS_PER_SESSION = 5
# Findings past this index are not even inspected: a session that dumps dozens is not trusted.
MAX_PARSED_PER_SESSION = 20
DEDUPE_LINE_WINDOW = 3
EVIDENCE_MIN_CHARS = 10
EVIDENCE_MAX_CHARS = 600
SCENARIO_MIN_CHARS = 20
SCENARIO_MAX_CHARS = 500
SUGGESTION_MAX_CHARS = 300
LINEAR_QUOTE_MIN_CHARS = 20

DROP_MALFORMED = "malformed"
DROP_UNKNOWN_RULE = "unknown_rule"
DROP_SCRIPT_RULE = "script_owned_rule"
DROP_RULE_NOT_IN_SESSION = "rule_not_in_session"
DROP_LOW_CONFIDENCE = "low_confidence"
DROP_FILE_NOT_IN_DIFF = "file_not_in_diff"
DROP_LINE_NOT_IN_DIFF = "line_not_in_diff"
DROP_EVIDENCE_NOT_FOUND = "evidence_not_found"
DROP_LINEAR_UNVERIFIED = "linear_quote_unverified"
DROP_DUPLICATE = "duplicate"
DROP_OVER_CAP = "over_cap"

DROP_REASONS: tuple[str, ...] = (
    DROP_MALFORMED,
    DROP_UNKNOWN_RULE,
    DROP_SCRIPT_RULE,
    DROP_RULE_NOT_IN_SESSION,
    DROP_LOW_CONFIDENCE,
    DROP_FILE_NOT_IN_DIFF,
    DROP_LINE_NOT_IN_DIFF,
    DROP_EVIDENCE_NOT_FOUND,
    DROP_LINEAR_UNVERIFIED,
    DROP_DUPLICATE,
    DROP_OVER_CAP,
)

ACCEPTED_CONFIDENCE = ("high", "medium")
LINEAR_ISSUE_PATTERN = re.compile(r"^PRA-\d+$")
_MARKDOWN_NOISE = re.compile(r"[*`_>#]")


@dataclass
class SessionValidation:
    session: str
    parsed: list[dict[str, Any]] = field(default_factory=list)
    kept: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[dict[str, Any]] = field(default_factory=list)

    def drop(self, finding: Any, reason: str) -> None:
        self.dropped.append({"reason": reason, "finding": finding})


def normalize_quote(text: str) -> str:
    """Linear renders markdown, so quotes are compared without emphasis marks, case or spacing."""
    return collapse(_MARKDOWN_NOISE.sub("", text)).casefold()


def raw_findings(payload: Any) -> list[Any]:
    if not isinstance(payload, dict):
        return []
    findings = payload.get("findings")
    return findings if isinstance(findings, list) else []


def cited_linear_issues(payloads: dict[str, Any]) -> list[str]:
    """Issue ids the server must fetch before it can verify Linear quotes."""
    issues: set[str] = set()
    for payload in payloads.values():
        for finding in raw_findings(payload):
            issue = finding.get("linear_issue") if isinstance(finding, dict) else None
            if isinstance(issue, str) and LINEAR_ISSUE_PATTERN.match(issue.strip().upper()):
                issues.add(issue.strip().upper())
    return sorted(issues)


def _text(finding: dict[str, Any], key: str) -> str:
    value = finding.get(key)
    return value.strip() if isinstance(value, str) else ""


def _shape_error(finding: Any) -> bool:
    if not isinstance(finding, dict):
        return True
    line = finding.get("line")
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        return True
    if not _text(finding, "rule_id") or not _text(finding, "file"):
        return True
    if len(collapse(_text(finding, "evidence"))) < EVIDENCE_MIN_CHARS:
        return True
    if len(_text(finding, "evidence")) > EVIDENCE_MAX_CHARS:
        return True
    return len(_text(finding, "failure_scenario")) < SCENARIO_MIN_CHARS


def _linear_quote_verified(finding: dict[str, Any], linear_texts: dict[str, str]) -> bool:
    issue = _text(finding, "linear_issue").upper()
    quote = normalize_quote(_text(finding, "linear_quote"))
    if not LINEAR_ISSUE_PATTERN.match(issue) or len(quote) < LINEAR_QUOTE_MIN_CHARS:
        return False
    return quote in normalize_quote(linear_texts.get(issue, ""))


def _reject_reason(
    session: str,
    finding: Any,
    diff: DiffIndex,
    linear_texts: dict[str, str],
) -> str | None:
    if _shape_error(finding):
        return DROP_MALFORMED

    rule_id = _text(finding, "rule_id")
    if rule_id in SCRIPT_RULE_IDS:
        return DROP_SCRIPT_RULE
    if rule_id not in MODEL_RULE_IDS:
        return DROP_UNKNOWN_RULE
    if rule_id not in SESSION_RULE_IDS.get(session, ()):
        return DROP_RULE_NOT_IN_SESSION
    if finding.get("confidence") not in ACCEPTED_CONFIDENCE:
        return DROP_LOW_CONFIDENCE

    path = _text(finding, "file")
    if not diff.has_file(path):
        return DROP_FILE_NOT_IN_DIFF
    if not diff.has_line(path, finding["line"]):
        return DROP_LINE_NOT_IN_DIFF
    if not diff.find_quote(path, _text(finding, "evidence")):
        return DROP_EVIDENCE_NOT_FOUND

    is_linear_claim = RULES[rule_id].needs_linear_quote or bool(_text(finding, "linear_issue"))
    if is_linear_claim and not _linear_quote_verified(finding, linear_texts):
        return DROP_LINEAR_UNVERIFIED
    return None


def _clean(session: str, finding: dict[str, Any], diff: DiffIndex) -> dict[str, Any]:
    """Keep only whitelisted fields, and anchor the line on the verified quote rather than the model's count."""
    path = _text(finding, "file")
    claimed = finding["line"]
    quote_lines = diff.find_quote(path, _text(finding, "evidence"))
    anchored = min(quote_lines, key=lambda number: abs(number - claimed))
    linear_issue = _text(finding, "linear_issue").upper()
    return {
        "rule_id": _text(finding, "rule_id"),
        "file": path,
        "line": anchored,
        "evidence": _text(finding, "evidence"),
        "failure_scenario": _text(finding, "failure_scenario")[:SCENARIO_MAX_CHARS],
        "suggestion": _text(finding, "suggestion")[:SUGGESTION_MAX_CHARS] or None,
        "confidence": finding["confidence"],
        "linear_issue": linear_issue or None,
        "linear_quote": _text(finding, "linear_quote") or None,
        "sessions": [session],
    }


def validate_session(
    session: str,
    payload: Any,
    diff: DiffIndex,
    linear_texts: dict[str, str] | None = None,
) -> SessionValidation:
    result = SessionValidation(session=session, parsed=list(raw_findings(payload)))
    texts = linear_texts or {}
    valid: list[dict[str, Any]] = []

    for index, finding in enumerate(result.parsed):
        if index >= MAX_PARSED_PER_SESSION:
            result.drop(finding, DROP_OVER_CAP)
            continue
        reason = _reject_reason(session, finding, diff, texts)
        if reason:
            result.drop(finding, reason)
        else:
            valid.append(_clean(session, finding, diff))

    valid.sort(key=lambda item: ACCEPTED_CONFIDENCE.index(item["confidence"]))
    result.kept = valid[:MAX_FINDINGS_PER_SESSION]
    for finding in valid[MAX_FINDINGS_PER_SESSION:]:
        result.drop(finding, DROP_OVER_CAP)
    return result


def _is_duplicate(finding: dict[str, Any], other: dict[str, Any]) -> bool:
    same_place = finding["file"] == other["file"] and finding["rule_id"] == other["rule_id"]
    return same_place and abs(finding["line"] - other["line"]) <= DEDUPE_LINE_WINDOW


def dedupe(sessions: list[SessionValidation]) -> list[dict[str, Any]]:
    """Merge duplicates across and within sessions; the first one wins and records who else saw it."""
    unique: list[dict[str, Any]] = []
    for result in sessions:
        survivors: list[dict[str, Any]] = []
        for finding in result.kept:
            original = next((item for item in unique if _is_duplicate(finding, item)), None)
            if original is None:
                unique.append(finding)
                survivors.append(finding)
                continue
            if result.session not in original["sessions"]:
                original["sessions"].append(result.session)
            result.drop(finding, DROP_DUPLICATE)
        result.kept = survivors
    return unique


def validate_run(
    payloads: dict[str, Any],
    diff: DiffIndex,
    linear_texts: dict[str, str] | None = None,
) -> tuple[list[SessionValidation], list[dict[str, Any]]]:
    """Validate every session in a stable order, then dedupe; returns per-session results and posted findings."""
    ordered = [key for key in SESSION_RULE_IDS if key in payloads]
    ordered.extend(sorted(key for key in payloads if key not in SESSION_RULE_IDS))
    sessions = [validate_session(key, payloads[key], diff, linear_texts) for key in ordered]
    return sessions, dedupe(sessions)
