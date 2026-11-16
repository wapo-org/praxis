from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from github_api import (
    GitHubAuthError,
    classify_github_token,
    classify_review_threads,
    fetch_pr_details,
    fetch_review_thread_outcomes,
    is_fork_pr,
    parse_webhook_event,
    require_usable_token,
    submit_pr_review,
    upsert_status_comment,
    verify_github_signature,
)
from pipeline import STATUS_ERROR, RunState, run_and_record
from runlog import load_run_records, write_run_record

REVIEW = {
    "verdict": "REQUEST_CHANGES",
    "body": "## Praxis PR review",
    "comments": [{"path": "a.ts", "line": 3, "side": "RIGHT", "body": "finding text"}],
}


def client_for(handler: Any) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


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


def test_webhook_rejects_repositories_outside_the_allow_list() -> None:
    payload = {"repository": {"full_name": "someone/else"}, "action": "opened", "pull_request": {"number": 1}}
    trigger, reason = parse_webhook_event("pull_request", payload)
    assert trigger is None
    assert "ALLOWED_REPOS" in reason
    trigger, _ = parse_webhook_event(
        "pull_request",
        {**payload, "pull_request": {"number": 1, "head": {}, "base": {}}},
        allowed_repos=("someone/else",),
    )
    assert trigger is not None


def test_is_fork_pr_covers_comment_triggered_runs() -> None:
    same = {"head": {"repo": {"full_name": "wapo-org/praxis"}}, "base": {"repo": {"full_name": "wapo-org/praxis"}}}
    fork = {"head": {"repo": {"full_name": "evil/praxis"}}, "base": {"repo": {"full_name": "wapo-org/praxis"}}}
    deleted = {"head": {"repo": None}, "base": {"repo": {"full_name": "wapo-org/praxis"}}}
    assert is_fork_pr(same) is False
    assert is_fork_pr(fork) is True
    assert is_fork_pr(deleted) is True


def test_token_kind_is_classified_by_prefix_and_oauth_tokens_are_refused() -> None:
    assert classify_github_token("github_pat_11ABC") == "fine_grained_pat"
    assert classify_github_token("ghs_abc") == "github_app_installation"
    assert classify_github_token("ghp_abc") == "classic_pat"
    assert classify_github_token("gho_abc") == "oauth_app"
    assert classify_github_token("something") == "unknown"
    assert require_usable_token("github_pat_11ABC") == "fine_grained_pat"
    with pytest.raises(GitHubAuthError, match="OAuth App") as caught:
        require_usable_token("gho_secretvalue1234567890")
    assert "gho_secretvalue" not in str(caught.value)


def test_submit_falls_back_to_comment_when_reviewing_own_pr() -> None:
    events: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        events.append(payload["event"])
        if payload["event"] == "REQUEST_CHANGES":
            return httpx.Response(422, json={"message": "Can not request changes on your own pull request"})
        return httpx.Response(200, json={"id": 7})

    with client_for(handler) as client:
        assert submit_pr_review(client, "wapo-org/praxis", 5, "abc", REVIEW) == {"id": 7}
    assert events == ["REQUEST_CHANGES", "COMMENT"]


def test_submit_moves_inline_comments_into_the_body_when_anchors_are_rejected() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        bodies.append(payload)
        if payload["comments"]:
            return httpx.Response(422, json={"message": "line must be part of the diff"})
        return httpx.Response(200, json={"id": 8})

    with client_for(handler) as client:
        submit_pr_review(client, "wapo-org/praxis", 5, "abc", {**REVIEW, "verdict": "COMMENT"})
    assert bodies[-1]["comments"] == []
    assert "`a.ts:3`" in bodies[-1]["body"] and "finding text" in bodies[-1]["body"]


@pytest.mark.parametrize("status_code", [401, 403])
def test_every_github_call_raises_an_explicit_auth_error(status_code: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"message": "Resource not accessible by personal access token"})

    with client_for(handler) as client:
        with pytest.raises(GitHubAuthError, match="read the pull request") as read_error:
            fetch_pr_details(client, "wapo-org/praxis", 5)
        with pytest.raises(GitHubAuthError, match="post the review"):
            submit_pr_review(client, "wapo-org/praxis", 5, "abc", REVIEW)
        with pytest.raises(GitHubAuthError, match="list pull request comments"):
            upsert_status_comment(client, "wapo-org/praxis", 5, "status")
        with pytest.raises(GitHubAuthError, match="read review threads"):
            fetch_review_thread_outcomes(client, "wapo-org/praxis", 5)

    message = str(read_error.value)
    assert str(status_code) in message
    assert "Resource not accessible by personal access token" in message
    assert "fine-grained PAT or a GitHub App token" in message and "expired" in message


def test_other_github_errors_still_raise() -> None:
    with client_for(lambda request: httpx.Response(500)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            fetch_pr_details(client, "wapo-org/praxis", 5)


@pytest.mark.parametrize("status_code", [401, 403])
def test_auth_failure_is_written_to_the_run_log_and_re_raised(status_code: int, tmp_path: Path) -> None:
    token = "github_pat_11SECRETSECRETSECRETSECRET"
    state = RunState(
        run_id="run123",
        repo="wapo-org/praxis",
        pr_number=5,
        trigger="pull_request:opened",
        model="muse-ember-1.0",
        reasoning_effort="max",
        started_at="2026-11-16T10:00:00Z",
    )

    def review(run: RunState) -> dict[str, Any]:
        run.head_sha = "abcdef1234"
        handler = lambda request: httpx.Response(status_code, json={"message": f"Bad credentials for {token}"})  # noqa: E731
        with client_for(handler) as client:
            submit_pr_review(client, run.repo, run.pr_number, run.head_sha, REVIEW)
        return {"status": "reviewed"}

    with pytest.raises(GitHubAuthError):
        run_and_record(
            state,
            review,
            lambda record: write_run_record(tmp_path, record),
            elapsed=lambda: 12.5,
            secrets=(token,),
        )

    [record] = load_run_records(tmp_path, limit=10)
    assert record["status"] == STATUS_ERROR
    assert record["review_id"] is None and record["verdict"] is None
    assert record["error"].startswith(f"GitHubAuthError: GitHub returned {status_code} while trying to post the review")
    assert token not in json.dumps(record)
    assert record["duration_seconds"] == 12.5


def test_review_threads_are_classified_for_the_wont_fix_share() -> None:
    def thread(resolved: bool, *bodies: tuple[str, str]) -> dict[str, Any]:
        nodes = [{"body": body, "author": {"login": "x", "__typename": kind}} for body, kind in bodies]
        return {"isResolved": resolved, "comments": {"nodes": nodes}}

    first = ("finding <!-- muse-finding:R5.secret-leak -->", "Bot")
    threads = [
        thread(True, first, ("Won't fix, this is a test key", "User")),
        thread(True, first, ("done", "User")),
        thread(False, ("x <!-- muse-finding:G.dead-code -->", "Bot"), ("wontfix", "Bot")),
        thread(False, ("a human comment with no marker", "User")),
        thread(False),
    ]
    assert classify_review_threads(threads) == [
        {"rule_id": "R5.secret-leak", "outcome": "wont_fix"},
        {"rule_id": "R5.secret-leak", "outcome": "resolved"},
        {"rule_id": "G.dead-code", "outcome": "open"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["variables"] == {"owner": "wapo-org", "name": "praxis", "number": 5}
        data = {"repository": {"pullRequest": {"reviewThreads": {"nodes": threads[:1]}}}}
        return httpx.Response(200, json={"data": data})

    with client_for(handler) as client:
        assert fetch_review_thread_outcomes(client, "wapo-org/praxis", 5) == [
            {"rule_id": "R5.secret-leak", "outcome": "wont_fix"}
        ]
