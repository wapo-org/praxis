from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from github_api import GitHubAuthError
from muse_output import ERROR_NOT_JSON, MuseOutput
from orchestrate import FORK_SKIP_REASON, Checkout, ReviewDeps, review_pull_request
from pipeline import RunState, SessionRun, run_and_record
from runlog import load_run_records, write_run_record

REPO = "wapo-org/praxis"
PATH = "cloud/apps/api/src/routes.ts"
PATCH = "@@ -1,0 +1,2 @@\n+const { userId } = await c.req.json();\n+return c.json({ ok: true });\n"
TOKEN = "github_pat_11TESTTESTTESTTESTTESTTEST"
FINDING = {
    "rule_id": "R5.owner-from-auth",
    "file": PATH,
    "line": 1,
    "evidence": "const { userId } = await c.req.json();",
    "failure_scenario": "Any signed-in user can pass another user's id and act as them.",
    "suggestion": None,
    "confidence": "high",
    "linear_issue": None,
    "linear_quote": None,
}


class FakeGitHub:
    def __init__(self, *, head_repo: str = REPO, review_status: int = 200) -> None:
        self.head_repo = head_repo
        self.review_status = review_status
        self.posted: list[dict[str, Any]] = []
        self.status_comments: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/pulls/5"):
            return httpx.Response(
                200,
                json={
                    "title": "Add route",
                    "body": "",
                    "head": {"sha": "abcdef1234567", "ref": "feat", "repo": {"full_name": self.head_repo}},
                    "base": {"ref": "main", "repo": {"full_name": REPO, "id": 1}},
                },
            )
        if path.endswith("/pulls/5/files"):
            return httpx.Response(200, json=[{"filename": PATH, "patch": PATCH}])
        if path.endswith("/issues/5/comments"):
            if request.method == "POST":
                self.status_comments.append(json.loads(request.content)["body"])
            return httpx.Response(200, json=[])
        if path.endswith("/pulls/5/reviews"):
            if self.review_status != 200:
                return httpx.Response(self.review_status, json={"message": "Resource not accessible"})
            self.posted.append(json.loads(request.content))
            return httpx.Response(200, json={"id": 4242})
        return httpx.Response(404)


def run(tmp_path: Path, github: FakeGitHub, sandbox_calls: list[Checkout], allow_forks: bool = False) -> dict[str, Any]:
    def run_in_sandbox(checkout: Checkout) -> tuple[list[dict[str, Any]], list[SessionRun]]:
        sandbox_calls.append(checkout)
        good = MuseOutput(payload={"session": "security", "findings": [FINDING]}, error=None, final_text="{}")
        bad = MuseOutput(payload=None, error=ERROR_NOT_JSON, final_text="prose")
        return [], [
            SessionRun("security", good, "raw security", 0, 3.0),
            SessionRun("logic_bs", bad, "I think this is fine", 0, 2.0),
        ]

    deps = ReviewDeps(
        github_token=TOKEN,
        model="muse-ember-1.0",
        secret_env={},
        allow_forks=allow_forks,
        run_in_sandbox=run_in_sandbox,
        secrets=(TOKEN,),
    )
    state = RunState(
        run_id="run1",
        repo=REPO,
        pr_number=5,
        trigger="issue_comment",
        model="muse-ember-1.0",
        reasoning_effort="max",
        started_at="2026-11-16T10:00:00Z",
    )
    with httpx.Client(transport=httpx.MockTransport(github), base_url="https://api.github.com") as gh:
        return run_and_record(
            state,
            lambda current: review_pull_request(current, gh, deps),
            lambda record: write_run_record(tmp_path, record),
            elapsed=lambda: 5.0,
            secrets=(TOKEN,),
        )


def test_review_posts_only_verified_findings_and_records_the_run(tmp_path: Path) -> None:
    github, calls = FakeGitHub(), []
    result = run(tmp_path, github, calls)
    assert result == {
        "status": "reviewed",
        "run_id": "run1",
        "verdict": "REQUEST_CHANGES",
        "findings_count": 1,
        "session_errors": {"logic_bs": ERROR_NOT_JSON},
        "review_id": 4242,
    }
    [checkout] = calls
    assert (checkout.commit, checkout.diff_base, checkout.refs) == ("abcdef1234567", "origin/main", ["main", "abcdef1234567"])
    assert len(checkout.tasks) == 5
    assert checkout.repo_id == 1 and checkout.pr_context["repo"] == REPO

    [posted] = github.posted
    assert posted["event"] == "REQUEST_CHANGES" and posted["commit_id"] == "abcdef1234567"
    assert [(comment["path"], comment["line"]) for comment in posted["comments"]] == [(PATH, 1)]
    assert "I think this is fine" not in json.dumps(posted)
    assert github.status_comments == []

    [record] = load_run_records(tmp_path, limit=5)
    assert record["status"] == "reviewed" and record["review_id"] == 4242
    assert record["github_token_kind"] == "fine_grained_pat"
    assert record["sessions"][1]["raw_output"] == "I think this is fine"


def test_fork_pr_from_a_comment_trigger_is_skipped_before_any_sandbox(tmp_path: Path) -> None:
    github, calls = FakeGitHub(head_repo="evil/praxis"), []
    result = run(tmp_path, github, calls)
    assert result == {"status": "skipped", "run_id": "run1", "reason": FORK_SKIP_REASON}
    assert calls == [] and github.posted == [] and github.status_comments == []
    [record] = load_run_records(tmp_path, limit=5)
    assert record["status"] == "skipped" and record["error"] == FORK_SKIP_REASON

    allowed_calls: list[Checkout] = []
    assert run(tmp_path, FakeGitHub(head_repo="evil/praxis"), allowed_calls, allow_forks=True)["status"] == "reviewed"
    assert len(allowed_calls) == 1


@pytest.mark.parametrize("status_code", [401, 403])
def test_github_refusing_the_review_fails_the_run_loudly(status_code: int, tmp_path: Path) -> None:
    github, calls = FakeGitHub(review_status=status_code), []
    with pytest.raises(GitHubAuthError, match=f"GitHub returned {status_code} while trying to post the review"):
        run(tmp_path, github, calls)
    [record] = load_run_records(tmp_path, limit=5)
    assert record["status"] == "error"
    assert f"GitHub returned {status_code}" in record["error"]
    assert record["review_id"] is None
    assert len(record["sessions"]) == 2 and record["posted_findings"] != []
    assert TOKEN not in json.dumps(record)
