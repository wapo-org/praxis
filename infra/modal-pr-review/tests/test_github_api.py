from __future__ import annotations

import hashlib
import hmac
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import _parse_muse_jsonl_output
from github_api import (
    format_review_markdown,
    merge_session_reviews,
    parse_diff_right_lines,
    parse_webhook_event,
    submit_pr_review,
    verify_github_signature,
)


def test_verify_github_signature() -> None:
    secret = "top-secret-webhook"
    body = b'{"action":"opened"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    assert verify_github_signature(body, sig, secret) is True
    assert verify_github_signature(body, "sha256=deadbeef", secret) is False
    assert verify_github_signature(body, None, secret) is False
    assert verify_github_signature(body, "md5=1234", secret) is False


def test_parse_webhook_pull_request_triggers_and_skips() -> None:
    opened_payload = {
        "repository": {"full_name": "wapo-org/praxis"},
        "action": "opened",
        "pull_request": {
            "number": 42,
            "draft": False,
            "title": "Add sidebar search",
            "body": "Implements Cmd+K search",
            "head": {"sha": "abc1234", "ref": "feat/search", "repo": {"full_name": "wapo-org/praxis"}},
            "base": {"ref": "main"},
        },
    }
    trigger, reason = parse_webhook_event("pull_request", opened_payload)
    assert trigger is not None
    assert reason == "accepted"
    assert trigger.repo_full_name == "wapo-org/praxis"
    assert trigger.pr_number == 42
    assert trigger.head_sha == "abc1234"

    draft_payload = {
        **opened_payload,
        "pull_request": {**opened_payload["pull_request"], "draft": True},
    }
    trigger, reason = parse_webhook_event("pull_request", draft_payload)
    assert trigger is None
    assert "draft" in reason

    fork_payload = {
        **opened_payload,
        "pull_request": {
            **opened_payload["pull_request"],
            "head": {"sha": "def5678", "ref": "patch-1", "repo": {"full_name": "stranger/praxis"}},
        },
    }
    trigger, reason = parse_webhook_event("pull_request", fork_payload)
    assert trigger is None
    assert "fork" in reason


def test_parse_webhook_issue_comment_command() -> None:
    payload = {
        "repository": {"full_name": "wapo-org/praxis"},
        "action": "created",
        "issue": {"number": 99, "pull_request": {"url": "https://api.github.com/..."}},
        "comment": {
            "body": "Looks good, /muse test the dark mode toggle by hand",
            "author_association": "MEMBER",
        },
    }
    trigger, reason = parse_webhook_event("issue_comment", payload)
    assert trigger is not None
    assert reason == "accepted"
    assert trigger.pr_number == 99
    assert trigger.custom_instructions == "test the dark mode toggle by hand"

    outsider = {
        **payload,
        "comment": {**payload["comment"], "author_association": "NONE"},
    }
    trigger, reason = parse_webhook_event("issue_comment", outsider)
    assert trigger is None
    assert "non-collaborator" in reason


def test_parse_diff_right_lines() -> None:
    patch = "\n".join(
        [
            "@@ -10,4 +10,5 @@ export function demo() {",
            " const a = 1;",
            "-const b = 2;",
            "+const b = 3;",
            "+const c = 4;",
            " return a + b;",
            "@@ -30,2 +31,2 @@",
            "-oldCall();",
            "+newCall();",
        ]
    )
    valid = parse_diff_right_lines(patch)
    assert valid == {10, 11, 12, 13, 31}


def test_submit_pr_review_falls_back_from_422_self_approve() -> None:
    seen_payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        payload = _json.loads(request.content.decode())
        seen_payloads.append(payload)
        if payload["event"] == "APPROVE":
            return httpx.Response(422, json={"message": "Can not approve your own pull request"})
        return httpx.Response(200, json={"id": 777, "state": "COMMENTED"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    review = {
        "verdict": "APPROVE",
        "summary": "All checks and Playwright run passed.",
        "linear_checks": [
            {"issue_id": "PRA-74", "status": "aligned", "note": "Uses @praxis/credentials."}
        ],
        "hands_on_testing": {
            "ran": True,
            "environment": "Modal Sandbox",
            "checks_passed": ["typecheck", "p0-check.mjs"],
            "checks_failed": [],
            "manual_observations": "Verified login and chat flow in Chromium.",
        },
        "findings": [
            {
                "severity": "nit",
                "tone": "question_offer",
                "sessions": ["conciseness"],
                "path": "cloud/apps/web/src/App.tsx",
                "line": 12,
                "title": "Inline note",
                "body": "Could we collapse this wrapper?",
                "suggestion": None,
                "rule_or_issue": None,
            },
            {
                "severity": "minor",
                "tone": "question_offer",
                "sessions": ["abstractions"],
                "path": "cloud/apps/web/src/App.tsx",
                "line": 999,
                "title": "Out-of-diff note",
                "body": "Should land in body instead of inline.",
                "suggestion": "Move timeout to constants.ts",
                "rule_or_issue": "AGENTS.md#2",
            },
        ],
    }
    res = submit_pr_review(
        client,
        "wapo-org/praxis",
        12,
        "deadbeef",
        review,
        {"cloud/apps/web/src/App.tsx": {12}},
    )
    assert res["id"] == 777
    assert len(seen_payloads) == 2
    assert seen_payloads[0]["event"] == "APPROVE"
    assert seen_payloads[1]["event"] == "COMMENT"
    assert len(seen_payloads[1]["comments"]) == 1
    assert seen_payloads[1]["comments"][0]["line"] == 12
    assert "[conciseness]" in seen_payloads[1]["comments"][0]["body"]
    assert "Out-of-diff note" in seen_payloads[1]["body"]
    assert "PRA-74" in seen_payloads[1]["body"]


def test_merge_session_reviews_non_opinionated_stays_comment_and_dedups() -> None:
    sessions = [
        {
            "session": "abstractions",
            "blocking_issues": False,
            "summary": "Could consider extracting a route constant.",
            "linear_checks": [{"issue_id": "PRA-74", "status": "aligned", "note": "Matches boundary"}],
            "findings": [
                {
                    "severity": "minor",
                    "tone": "question_offer",
                    "path": "cloud/apps/api/src/app.ts",
                    "line": 20,
                    "title": "Extract route constant",
                    "body": "Would it help to move this path string to constants.ts?",
                    "suggestion": "export const HEALTH_PATH = '/health';",
                    "rule_or_issue": "AGENTS.md#2",
                }
            ],
        },
        {
            "session": "conciseness",
            "blocking_issues": False,
            "summary": "Looks tidy overall.",
            "linear_checks": [],
            "findings": [
                {
                    "severity": "nit",
                    "tone": "question_offer",
                    "path": "cloud/apps/api/src/app.ts",
                    "line": 20,
                    "title": "  extract   route constant ",
                    "body": "Duplicate mention.",
                    "suggestion": None,
                    "rule_or_issue": None,
                }
            ],
        },
    ]
    hands_on = {
        "ran": True,
        "environment": "Modal Sandbox (Linux)",
        "checks_passed": ["typecheck", "test"],
        "checks_failed": [],
        "manual_observations": "Tested /health and UI.",
        "findings": [],
    }
    merged = merge_session_reviews(sessions, hands_on)
    assert merged["verdict"] == "COMMENT"
    assert len(merged["findings"]) == 1
    assert merged["findings"][0]["sessions"] == ["abstractions", "conciseness"]


def test_merge_session_reviews_escalates_on_hard_boundary_or_linear_contradiction() -> None:
    base_hands_on = {
        "ran": True,
        "environment": "Modal Sandbox (Linux)",
        "checks_passed": ["typecheck"],
        "checks_failed": [],
        "manual_observations": "ok",
        "findings": [],
    }

    hard_flag = merge_session_reviews(
        [
            {
                "session": "security",
                "blocking_issues": False,
                "summary": "Found boundary violation.",
                "linear_checks": [],
                "findings": [
                    {
                        "severity": "major",
                        "tone": "hard_boundary_flag",
                        "path": "cloud/apps/api/src/app.ts",
                        "line": 44,
                        "title": "Reads client-supplied userId",
                        "body": "Violates AGENTS.md#5.",
                        "suggestion": "Use verified session userId.",
                        "rule_or_issue": "PRA-35",
                    }
                ],
            }
        ],
        base_hands_on,
    )
    assert hard_flag["verdict"] == "REQUEST_CHANGES"

    linear_contradiction = merge_session_reviews(
        [
            {
                "session": "maintainability",
                "blocking_issues": False,
                "summary": "Aligned check failed.",
                "linear_checks": [
                    {"issue_id": "PRA-73", "status": "aligned", "note": "Initial"},
                ],
                "findings": [],
            },
            {
                "session": "logic_bs",
                "blocking_issues": False,
                "summary": "Reintroduced legacy shim.",
                "linear_checks": [
                    {"issue_id": "PRA-73", "status": "contradiction", "note": "Keeps legacy shim."},
                ],
                "findings": [],
            },
        ],
        base_hands_on,
    )
    assert linear_contradiction["verdict"] == "REQUEST_CHANGES"
    assert linear_contradiction["linear_checks"][0]["status"] == "contradiction"

    failed_check = merge_session_reviews(
        [{"session": "abstractions", "blocking_issues": False, "summary": "ok", "linear_checks": [], "findings": []}],
        {**base_hands_on, "checks_failed": ["npm --prefix cloud test"]},
    )
    assert failed_check["verdict"] == "REQUEST_CHANGES"
    md = format_review_markdown(linear_contradiction, [])
    assert "### Linear (`PRA`) Alignment" in md


def test_parse_muse_jsonl_output() -> None:
    jsonl = "\n".join(
        [
            '{"schema_version":1,"payload_type":"run.started","payload":{}}',
            '{"schema_version":1,"payload_type":"run.output.delta","payload":{"text":"{\\"verdict\\":"}}',
            '{"schema_version":1,"payload_type":"run.terminal.completed","payload":{"text":"{\\"verdict\\":\\"COMMENT\\",\\"summary\\":\\"ok\\",\\"hands_on_testing\\":{\\"ran\\":true,\\"environment\\":\\"linux\\",\\"checks_passed\\":[],\\"checks_failed\\":[],\\"manual_observations\\":\\"ok\\"},\\"findings\\":[]}"}}',
        ]
    )
    parsed, raw = _parse_muse_jsonl_output(jsonl)
    assert parsed is not None
    assert parsed["verdict"] == "COMMENT"
    assert "ok" in raw
