from __future__ import annotations

from typing import Any

import pytest

from diff_index import DiffIndex, parse_diff_right_lines, parse_diff_right_text
from validation import (
    DROP_DUPLICATE,
    DROP_EVIDENCE_NOT_FOUND,
    DROP_FILE_NOT_IN_DIFF,
    DROP_LINE_NOT_IN_DIFF,
    DROP_LINEAR_UNVERIFIED,
    DROP_LOW_CONFIDENCE,
    DROP_MALFORMED,
    DROP_OVER_CAP,
    DROP_RULE_NOT_IN_SESSION,
    DROP_SCRIPT_RULE,
    DROP_UNKNOWN_RULE,
    MAX_FINDINGS_PER_SESSION,
    cited_linear_issues,
    validate_run,
    validate_session,
)

PATH = "cloud/apps/api/src/routes.ts"
PATCH = """@@ -10,4 +10,6 @@ export function register(app) {
 const app = new Hono();
-app.get('/old', oldHandler);
+app.post('/v1/share', async (c) => {
+  const { userId, fileId } = await c.req.json();
+  jsonLog('share', { token: c.req.header('authorization') });
   return c.json({ ok: true });
 });
"""
DIFF = DiffIndex.from_pr_files([{"filename": PATH, "patch": PATCH}, {"filename": "logo.png"}])
LINEAR = {"PRA-41": "**Goal**\n\n3. No client-facing route stays on Vercel. Routes that need secrets move."}


def finding(**overrides: Any) -> dict[str, Any]:
    base = {
        "rule_id": "R5.owner-from-auth",
        "file": PATH,
        "line": 12,
        "evidence": "const { userId, fileId } = await c.req.json();",
        "failure_scenario": "Any signed-in user can pass another user's id and read their file.",
        "suggestion": "Could the owner come from the session?",
        "confidence": "high",
        "linear_issue": None,
        "linear_quote": None,
    }
    return {**base, **overrides}


def reasons(session: str, *findings: Any) -> list[str]:
    result = validate_session(session, {"session": session, "findings": list(findings)}, DIFF, LINEAR)
    return [dropped["reason"] for dropped in result.dropped]


def test_diff_index_maps_new_side_lines_and_text() -> None:
    assert parse_diff_right_lines(PATCH) == {10, 11, 12, 13, 14, 15}
    assert parse_diff_right_text(PATCH)[11] == "app.post('/v1/share', async (c) => {"
    assert parse_diff_right_text(None) == {}
    assert DIFF.has_file(PATH) and not DIFF.has_file("logo.png")
    assert DIFF.find_quote(PATH, "  const { userId,   fileId } = await c.req.json();") == [12]
    assert DIFF.find_quote(PATH, "app.get('/old', oldHandler);") == []
    two_lines = "app.post('/v1/share', async (c) => {\n  const { userId, fileId } = await c.req.json();"
    assert DIFF.find_quote(PATH, two_lines) == [11]


def test_valid_finding_is_kept_with_whitelisted_fields_only() -> None:
    result = validate_session("security", {"findings": [finding(extra="ignored", severity="critical")]}, DIFF)
    assert result.dropped == []
    assert result.kept == [
        {
            "rule_id": "R5.owner-from-auth",
            "file": PATH,
            "line": 12,
            "evidence": "const { userId, fileId } = await c.req.json();",
            "failure_scenario": "Any signed-in user can pass another user's id and read their file.",
            "suggestion": "Could the owner come from the session?",
            "confidence": "high",
            "linear_issue": None,
            "linear_quote": None,
            "sessions": ["security"],
        }
    ]


def test_line_is_re_anchored_on_the_verified_quote() -> None:
    result = validate_session("security", {"findings": [finding(line=14)]}, DIFF)
    assert result.kept[0]["line"] == 12


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"rule_id": "R9.made-up"}, DROP_UNKNOWN_RULE),
        ({"rule_id": "R4.no-any"}, DROP_SCRIPT_RULE),
        ({"rule_id": "GATE.test"}, DROP_SCRIPT_RULE),
        ({"rule_id": "G.dead-code"}, DROP_RULE_NOT_IN_SESSION),
        ({"confidence": "low"}, DROP_LOW_CONFIDENCE),
        ({"confidence": "certain"}, DROP_LOW_CONFIDENCE),
        ({"file": "cloud/apps/api/src/other.ts"}, DROP_FILE_NOT_IN_DIFF),
        ({"file": "logo.png"}, DROP_FILE_NOT_IN_DIFF),
        ({"line": 99}, DROP_LINE_NOT_IN_DIFF),
        ({"evidence": "the route reads the user id from the body"}, DROP_EVIDENCE_NOT_FOUND),
        ({"evidence": "app.get('/old', oldHandler);"}, DROP_EVIDENCE_NOT_FOUND),
        ({"evidence": "});"}, DROP_MALFORMED),
        ({"line": "12"}, DROP_MALFORMED),
        ({"line": 0}, DROP_MALFORMED),
        ({"failure_scenario": "bad"}, DROP_MALFORMED),
        ({"file": ""}, DROP_MALFORMED),
    ],
)
def test_unverifiable_findings_are_dropped_with_a_reason(overrides: dict[str, Any], expected: str) -> None:
    assert reasons("security", finding(**overrides)) == [expected]


def test_non_object_findings_and_payloads_are_handled() -> None:
    assert reasons("security", "free text", None, 7) == [DROP_MALFORMED] * 3
    assert validate_session("security", "not a dict", DIFF).parsed == []
    assert validate_session("security", {"findings": "nope"}, DIFF).kept == []


def test_linear_claims_need_a_quote_found_in_the_fetched_issue() -> None:
    claim = {
        "rule_id": "G.linear-contradiction",
        "line": 11,
        "evidence": "app.post('/v1/share', async (c) => {",
        "linear_issue": "pra-41",
    }
    good = finding(**claim, linear_quote="no client-facing route stays on  Vercel.")
    kept = validate_session("maintainability", {"findings": [good]}, DIFF, LINEAR).kept
    assert [item["linear_issue"] for item in kept] == ["PRA-41"]

    invented = finding(**claim, linear_quote="Every route must be deleted before Friday.")
    missing = finding(**claim, linear_quote=None)
    too_short = finding(**claim, linear_quote="Vercel.")
    unknown_issue = finding(**{**claim, "linear_issue": "PRA-999"}, linear_quote="No client-facing route stays on Vercel.")
    no_issue = finding(**{**claim, "linear_issue": None}, linear_quote="No client-facing route stays on Vercel.")
    assert reasons("maintainability", invented, missing, too_short, unknown_issue, no_issue) == [DROP_LINEAR_UNVERIFIED] * 5

    not_fetched = validate_session("maintainability", {"findings": [good]}, DIFF, {})
    assert [dropped["reason"] for dropped in not_fetched.dropped] == [DROP_LINEAR_UNVERIFIED]

    other_rule_with_claim = finding(linear_issue="PRA-41", linear_quote="This sentence is not in the issue at all.")
    assert reasons("security", other_rule_with_claim) == [DROP_LINEAR_UNVERIFIED]


def test_cited_linear_issues_lists_only_well_formed_ids() -> None:
    payloads = {
        "a": {"findings": [finding(linear_issue="pra-41"), finding(linear_issue="JIRA-1"), "text"]},
        "b": {"findings": [finding(linear_issue="PRA-13"), finding(linear_issue=None)]},
        "c": None,
    }
    assert cited_linear_issues(payloads) == ["PRA-13", "PRA-41"]


def test_cap_keeps_five_per_session_high_confidence_first() -> None:
    lines = {number: f"const value{number} = compute({number});" for number in range(1, 31)}
    diff = DiffIndex(files={PATH: lines})
    findings = [
        finding(rule_id="CORRECTNESS", line=number, evidence=lines[number], confidence="medium" if number < 25 else "high")
        for number in range(1, 31)
    ]
    result = validate_session("logic_bs", {"findings": findings}, diff)
    assert len(result.kept) == MAX_FINDINGS_PER_SESSION
    assert [item["confidence"] for item in result.kept] == ["medium"] * 5
    assert [dropped["reason"] for dropped in result.dropped] == [DROP_OVER_CAP] * 25

    few = validate_session("logic_bs", {"findings": findings[18:]}, diff)
    assert [item["confidence"] for item in few.kept] == ["high"] * 5


def test_dedupe_merges_same_file_rule_and_line_window_across_sessions() -> None:
    near = finding(rule_id="CORRECTNESS", line=13, evidence="jsonLog('share', { token: c.req.header('authorization') });")
    same = finding(rule_id="CORRECTNESS", line=11, evidence="app.post('/v1/share', async (c) => {")
    other_rule = finding(rule_id="R3.root-cause", line=11, evidence="app.post('/v1/share', async (c) => {")
    payloads = {
        "hands_on": {"findings": [same]},
        "logic_bs": {"findings": [near, other_rule]},
    }
    sessions, posted = validate_run(payloads, DIFF)
    assert [(item["rule_id"], item["line"], item["sessions"]) for item in posted] == [
        ("CORRECTNESS", 13, ["logic_bs", "hands_on"]),
        ("R3.root-cause", 11, ["logic_bs"]),
    ]
    by_name = {result.session: result for result in sessions}
    assert [dropped["reason"] for dropped in by_name["hands_on"].dropped] == [DROP_DUPLICATE]
    assert by_name["hands_on"].kept == []
