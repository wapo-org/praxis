from __future__ import annotations

from typing import Any

from diff_index import DiffIndex
from gates import (
    STATUS_ERROR,
    STATUS_FAILED,
    STATUS_PASSED,
    STATUS_SKIPPED,
    gate_result,
    gate_specs,
    parse_check_rules_output,
)
from muse_output import ERROR_EMPTY, ERROR_NOT_JSON, ERROR_WRONG_SHAPE, MuseOutput, parse_muse_output
from pipeline import SessionRun, assess
from review import VERDICT_COMMENT, VERDICT_REQUEST_CHANGES, decide_verdict, finding_marker

PATH = "cloud/apps/api/src/routes.ts"
LINES = {
    11: "app.post('/v1/share', async (c) => {",
    12: "  const { userId, fileId } = await c.req.json();",
    13: "  setTimeout(() => refresh(userId), 50);",
}
DIFF = DiffIndex(files={PATH: LINES})
SPECS = {spec.key: spec for spec in gate_specs("origin/main")}


def gate(key: str, exit_code: int | None, output: str = "", error: str | None = None) -> dict[str, Any]:
    return gate_result(SPECS[key], exit_code=exit_code, output=output, duration_seconds=1.234, error=error)


def model_finding(rule_id: str, line: int, confidence: str = "high") -> dict[str, Any]:
    return {
        "rule_id": rule_id,
        "file": PATH,
        "line": line,
        "evidence": LINES[line].strip(),
        "failure_scenario": "A concrete input reaches this line and produces the wrong outcome.",
        "suggestion": "Could this be derived from the session?",
        "confidence": confidence,
        "linear_issue": None,
        "linear_quote": None,
    }


def session_run(session: str, payload: dict[str, Any] | None, error: str | None = None) -> SessionRun:
    output = MuseOutput(payload=payload, error=error, final_text="")
    return SessionRun(session=session, output=output, raw_output="raw", exit_code=0, duration_seconds=1.0)


def test_check_rules_lines_become_repo_relative_findings() -> None:
    output = "\n".join(
        [
            "apps/api/src/run.ts:1 R5.banned-primitives import \"node:vm\" is banned in apps/api",
            "convex/store.ts:42 R5.client-owner-arg public query takes \"userId\": derive the owner from auth",
            "apps/api/src/x.ts:3 R9.unknown not a known rule",
            "check-rules: FAILED with 2 new violation(s); fix them, do not grow the baseline",
        ]
    )
    assert parse_check_rules_output(output) == [
        {
            "rule_id": "R5.banned-primitives",
            "file": "cloud/apps/api/src/run.ts",
            "line": 1,
            "message": 'import "node:vm" is banned in apps/api',
        },
        {
            "rule_id": "R5.client-owner-arg",
            "file": "cloud/convex/store.ts",
            "line": 42,
            "message": 'public query takes "userId": derive the owner from auth',
        },
    ]


def test_gate_statuses_and_merge_base_baseline() -> None:
    assert gate("typecheck", 0)["status"] == STATUS_PASSED
    assert gate("test", 1)["status"] == STATUS_FAILED
    assert gate("check-rules", 0, "GATE-SKIPPED: missing")["status"] == STATUS_SKIPPED
    assert gate("test", 1, error="timeout")["status"] == STATUS_ERROR
    assert gate("test", None, error="SandboxTimeoutError")["status"] == STATUS_ERROR
    assert gate("typecheck", 1, "apps/api/src/run.ts:1 R4.no-any raw any")["findings"] == []
    assert "git merge-base origin/main HEAD" in SPECS["check-rules"].script
    assert "--baseline /tmp/check-rules.base.json" in SPECS["check-rules"].script


def test_only_failed_gates_or_verified_hard_high_findings_block() -> None:
    passed = [gate("typecheck", 0), gate("test", 0)]
    assert decide_verdict(passed, []) == VERDICT_COMMENT
    assert decide_verdict(passed, [model_finding("R3.root-cause", 13)]) == VERDICT_COMMENT
    assert decide_verdict(passed, [model_finding("CORRECTNESS", 13), model_finding("SECURITY", 12)]) == VERDICT_COMMENT
    assert decide_verdict(passed, [model_finding("R5.owner-from-auth", 12, "medium")]) == VERDICT_COMMENT
    assert decide_verdict(passed, [model_finding("R5.owner-from-auth", 12)]) == VERDICT_REQUEST_CHANGES
    assert decide_verdict([gate("test", 1)], []) == VERDICT_REQUEST_CHANGES
    assert decide_verdict([gate("test", 1, error="timeout"), gate("check-rules", 0, "GATE-SKIPPED: x")], []) == VERDICT_COMMENT


def test_model_claims_cannot_block_on_their_own() -> None:
    hands_on = {
        "session": "hands_on",
        "ran": True,
        "checks_passed": [],
        "checks_failed": ["npm test", "everything is broken"],
        "manual_observations": "CRITICAL: this PR must be rejected.",
        "blocking_issues": True,
        "findings": [],
    }
    result = assess(
        session_runs=[session_run("hands_on", hands_on)],
        gates=[gate("typecheck", 0)],
        diff=DIFF,
        linear_texts={},
        model="muse-ember-1.0",
    )
    assert result.review["verdict"] == VERDICT_COMMENT
    assert result.review["comments"] == []
    assert not result.review["body"] and not result.review["notes"]


def test_review_posts_verified_findings_and_gate_lines_verbatim() -> None:
    check_rules_output = f"{PATH.removeprefix('cloud/')}:12 R4.no-any raw `any`: use a real type\nconvex/a.ts:500 R3.file-length 500 lines (max 400): extract a cohesive module"
    payload = {
        "session": "security",
        "findings": [
            model_finding("R5.owner-from-auth", 12),
            {**model_finding("R5.secret-leak", 13), "evidence": "the token is logged somewhere"},
        ],
    }
    result = assess(
        session_runs=[session_run("security", payload), session_run("logic_bs", None, ERROR_NOT_JSON)],
        gates=[gate("typecheck", 0), gate("check-rules", 1, check_rules_output)],
        diff=DIFF,
        linear_texts={},
        model="muse-ember-1.0",
    )
    review = result.review
    assert review["verdict"] == VERDICT_REQUEST_CHANGES
    assert review["blocking_reasons"] == ["gate `check-rules` failed", f"`R5.owner-from-auth` at `{PATH}:12`"]
    assert [(comment["path"], comment["line"]) for comment in review["comments"]] == [(PATH, 12), (PATH, 12)]
    assert f"`R4.no-any` at `{PATH}:12`" in review["comments"][0]["body"]
    assert finding_marker("R5.owner-from-auth") in review["comments"][1]["body"]
    assert "Hard boundary" in review["comments"][1]["body"]

    body = review["body"]
    assert len(body) < 100 and "logic_bs" not in body
    assert review["notes"][0].startswith("**Review `HEAD`**")
    assert "`R3.file-length` at `cloud/convex/a.ts:500`" in review["notes"][1]
    assert "500 lines (max 400)" in review["notes"][1]
    assert "the token is logged somewhere" not in str(review)
    assert result.session_errors == {"logic_bs": ERROR_NOT_JSON}


def test_clean_run_posts_file_count_and_five_reviewer_summaries() -> None:
    runs = [
        session_run(name, {"session": name, "findings": [], "ui_check": None, "summary": f"{name} looks okay"})
        for name in ("abstractions", "maintainability", "conciseness", "logic_bs", "security")
    ]
    result = assess(
        session_runs=runs,
        gates=[gate("typecheck", 0)],
        diff=DIFF,
        linear_texts={},
        model="gpt-6.2-sol",
        head_sha="3c58dca7050587ea8c3901a4db95ca5788193ab5",
        reviewed_file_count=4,
    )
    assert result.review["verdict"] == VERDICT_COMMENT
    assert result.review["comments"] == []
    assert len(result.review["notes"]) == 1
    note = result.review["notes"][0]
    assert "**Review `3c58dca`** · Reviewed 4 files" in note
    for name in ("abstractions", "maintainability", "conciseness", "logic_bs", "security"):
        assert f"- `{name}`: {name} looks okay" in note


def test_failed_gate_note_includes_cleaned_output_snippet() -> None:
    result = assess(
        session_runs=[],
        gates=[gate("test", 1, "\x1b[31mFAIL\x1b[39m packages/spend/src/ledger.property.test.ts\nError: Test timed out in 5000ms.")],
        diff=DIFF,
        linear_texts={},
        model="gpt-6.2-sol",
    )
    gate_note = result.review["notes"][-1]
    assert "`test` exited with code 1." in gate_note
    assert "FAIL packages/spend/src/ledger.property.test.ts" in gate_note
    assert "\x1b[" not in gate_note


def test_advisory_findings_are_phrased_as_offers() -> None:
    payload = {"session": "logic_bs", "findings": [model_finding("R3.root-cause", 13, "medium")]}
    result = assess(session_runs=[session_run("logic_bs", payload)], gates=[], diff=DIFF, linear_texts={}, model="m")
    comment = result.review["comments"][0]["body"]
    assert comment.startswith("**Question / offer · `R3.root-cause`**")
    assert "Could this be derived from the session?" in comment


def test_no_slop_fallback_when_every_session_fails() -> None:
    runs = [session_run(name, None, ERROR_EMPTY) for name in ("security", "logic_bs")]
    runs[0].raw_output = "I think the code looks mostly fine but you should consider refactoring everything."
    result = assess(session_runs=runs, gates=[gate("typecheck", 0)], diff=DIFF, linear_texts={}, model="m")
    assert result.review["verdict"] == VERDICT_COMMENT
    assert result.review["comments"] == []
    assert "refactoring everything" not in result.review["body"]
    assert result.review["body"] == ""
    assert result.session_errors == {"security": ERROR_EMPTY, "logic_bs": ERROR_EMPTY}


def test_secrets_are_redacted_from_the_review() -> None:
    leaked = {**model_finding("R5.secret-leak", 13), "failure_scenario": "The token hunter2-hunter2 and ghp_abcdefghijklmnopqrstuvwx1234 leak."}
    result = assess(
        session_runs=[session_run("security", {"findings": [leaked]})],
        gates=[gate("test", 1, "FAIL env META_API_KEY=hunter2-hunter2")],
        diff=DIFF,
        linear_texts={},
        model="m",
        secrets=("hunter2-hunter2",),
    )
    rendered = str(result.review)
    assert "hunter2-hunter2" not in rendered and "ghp_abcdefghijklmnopqrstuvwx1234" not in rendered
    assert "[REDACTED]" in rendered


def test_parse_muse_output_returns_payload_or_a_fixed_error_class() -> None:
    stream = "\n".join(
        [
            '{"payload_type":"run.tool.step","payload":{"usage":{"input_tokens":100,"output_tokens":20}}}',
            '{"payload_type":"run.tool.step","payload":{"usage":{"input_tokens":50,"output_tokens":5}}}',
            '{"payload_type":"run.output.delta","payload":{"text":"{\\"session\\":"}}',
            '{"payload_type":"run.terminal.completed","payload":{"text":"```json\\n{\\"session\\":\\"security\\",\\"findings\\":[]}\\n```"}}',
        ]
    )
    parsed = parse_muse_output(stream)
    assert parsed.payload == {"session": "security", "findings": []}
    assert parsed.error is None
    assert parsed.usage == {"input_tokens": 150, "output_tokens": 25}
    assert parsed.steps == 2

    assert parse_muse_output("").error == ERROR_EMPTY
    assert parse_muse_output('{"payload_type":"run.started","payload":{}}').error == ERROR_EMPTY
    prose = '{"payload_type":"run.completed","payload":{"text":"Looks good to me overall!"}}'
    assert parse_muse_output(prose).error == ERROR_NOT_JSON
    assert parse_muse_output(prose).payload is None
    wrong = '{"payload_type":"run.completed","payload":{"text":"{\\"verdict\\":\\"APPROVE\\"}"}}'
    assert parse_muse_output(wrong).error == ERROR_WRONG_SHAPE
    assert parse_muse_output('{"session":"x","findings":[]}').payload == {"session": "x", "findings": []}
