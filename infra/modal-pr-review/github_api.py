from __future__ import annotations

import hashlib
import hmac
import os
import re
import subprocess
from pathlib import Path
from dataclasses import dataclass
from typing import Any

import httpx

from review import VERDICT_COMMENT, VERDICT_REQUEST_CHANGES, body_with_inline_comments

STATUS_COMMENT_MARKER = "<!-- codex-pr-review-status -->"
LEGACY_STATUS_COMMENT_MARKER = "<!-- muse-pr-review-status -->"
COMMAND_PATTERN = re.compile(
    r"(?:^|\s)(?:/review|/codex|/muse|@muse-review)\b(?P<instructions>.*)$",
    re.IGNORECASE | re.DOTALL,
)

GITHUB_API_VERSION = "2022-11-28"
GITHUB_PER_PAGE = 100
GITHUB_AUTH_STATUS_CODES = (401, 403)
GITHUB_ERROR_MESSAGE_CHARS = 300
DEFAULT_ALLOWED_REPOS = ("wapo-org/praxis",)

TOKEN_KIND_FINE_GRAINED_PAT = "fine_grained_pat"
TOKEN_KIND_APP_INSTALLATION = "github_app_installation"
TOKEN_KIND_APP_USER = "github_app_user"
TOKEN_KIND_CLASSIC_PAT = "classic_pat"
TOKEN_KIND_OAUTH_APP = "oauth_app"
TOKEN_KIND_UNKNOWN = "unknown"
_TOKEN_PREFIXES = (
    ("github_pat_", TOKEN_KIND_FINE_GRAINED_PAT),
    ("ghs_", TOKEN_KIND_APP_INSTALLATION),
    ("ghu_", TOKEN_KIND_APP_USER),
    ("ghp_", TOKEN_KIND_CLASSIC_PAT),
    ("gho_", TOKEN_KIND_OAUTH_APP),
)
TOKEN_HELP = (
    "GITHUB_TOKEN must be a fine-grained PAT or a GitHub App token for the repository "
    "(Contents and Pull requests read/write): the organization restricts OAuth App access, "
    "so `gho_` tokens get 403 on writes. Check that the token has not expired, then rotate it "
    "as described in infra/modal-pr-review/README.md."
)


class GitHubAuthError(RuntimeError):
    """GitHub refused the reviewer's token; the run must fail loudly instead of skipping the review."""

    def __init__(self, status_code: int, action: str, message: str) -> None:
        self.status_code = status_code
        self.action = action
        super().__init__(f"GitHub returned {status_code} while trying to {action}: {message}. {TOKEN_HELP}")


def classify_github_token(token: str) -> str:
    """Token family from its public prefix; never returns or logs any part of the secret itself."""
    for prefix, kind in _TOKEN_PREFIXES:
        if token.startswith(prefix):
            return kind
    return TOKEN_KIND_UNKNOWN


def require_usable_token(token: str) -> str:
    kind = classify_github_token(token)
    if kind == TOKEN_KIND_OAUTH_APP:
        raise GitHubAuthError(403, "start the review", "GITHUB_TOKEN is an OAuth App (`gho_`) token")
    return kind


def raise_for_github(response: httpx.Response, action: str) -> None:
    """401/403 become an explicit GitHubAuthError naming the action; other errors raise as usual."""
    if response.status_code in GITHUB_AUTH_STATUS_CODES:
        try:
            message = str(response.json().get("message") or "")
        except ValueError:
            message = ""
        detail = message[:GITHUB_ERROR_MESSAGE_CHARS] or "no message"
        raise GitHubAuthError(response.status_code, action, detail)
    response.raise_for_status()


@dataclass(frozen=True)
class ReviewTrigger:
    repo_full_name: str
    pr_number: int
    trigger_source: str
    head_sha: str | None = None
    head_ref: str | None = None
    base_ref: str | None = None
    pr_title: str | None = None
    pr_body: str | None = None
    is_fork: bool | None = None
    custom_instructions: str = ""


def verify_github_signature(
    raw_body: bytes,
    signature_header: str | None,
    secret: str,
) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected_digest = hmac.new(
        secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected_digest}", signature_header)


def parse_webhook_event(
    event_type: str,
    payload: dict[str, Any],
    *,
    review_drafts: bool = False,
    allow_forks: bool = False,
    allowed_repos: tuple[str, ...] = DEFAULT_ALLOWED_REPOS,
) -> tuple[ReviewTrigger | None, str]:
    repo = payload.get("repository") or {}
    repo_full_name = repo.get("full_name")
    if not repo_full_name:
        return None, "missing repository.full_name"
    if repo_full_name not in allowed_repos:
        return None, f"repository {repo_full_name} is not in ALLOWED_REPOS"

    if event_type == "pull_request":
        action = payload.get("action")
        if action not in {"opened", "synchronize", "reopened", "ready_for_review"}:
            return None, f"ignored pull_request action: {action}"

        pr = payload.get("pull_request") or {}
        if pr.get("draft") and not review_drafts and action != "ready_for_review":
            return None, "skipped draft pull request"

        head = pr.get("head") or {}
        base = pr.get("base") or {}
        head_repo = (head.get("repo") or {}).get("full_name")
        is_fork = bool(head_repo and head_repo != repo_full_name)
        if is_fork and not allow_forks:
            return None, "skipped fork pull request (set ALLOW_FORK_PRS=1 to enable)"

        return (
            ReviewTrigger(
                repo_full_name=repo_full_name,
                pr_number=int(pr["number"]),
                trigger_source=f"pull_request:{action}",
                head_sha=head.get("sha"),
                head_ref=head.get("ref"),
                base_ref=base.get("ref"),
                pr_title=pr.get("title") or "",
                pr_body=pr.get("body") or "",
                is_fork=is_fork,
            ),
            "accepted",
        )

    if event_type == "issue_comment":
        if payload.get("action") != "created":
            return None, f"ignored issue_comment action: {payload.get('action')}"

        issue = payload.get("issue") or {}
        if "pull_request" not in issue:
            return None, "ignored comment on non-PR issue"

        comment = payload.get("comment") or {}
        body = (comment.get("body") or "").strip()
        match = COMMAND_PATTERN.search(body)
        if not match:
            return None, "comment does not contain /muse or @muse-review"

        assoc = (comment.get("author_association") or "").upper()
        if assoc not in {"OWNER", "MEMBER", "COLLABORATOR"}:
            return None, f"ignored /muse command from non-collaborator ({assoc or 'NONE'})"

        instructions = (match.group("instructions") or "").strip()
        return (
            ReviewTrigger(
                repo_full_name=repo_full_name,
                pr_number=int(issue["number"]),
                trigger_source="issue_comment",
                custom_instructions=instructions,
            ),
            "accepted",
        )

    return None, f"ignored event type: {event_type}"


def github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }


def fetch_pr_details(
    client: httpx.Client,
    repo: str,
    pr_number: int,
) -> dict[str, Any]:
    resp = client.get(f"https://api.github.com/repos/{repo}/pulls/{pr_number}")
    raise_for_github(resp, "read the pull request")
    return resp.json()


def fetch_pr_files(
    client: httpx.Client,
    repo: str,
    pr_number: int,
) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    page = 1
    while True:
        resp = client.get(
            f"https://api.github.com/repos/{repo}/pulls/{pr_number}/files",
            params={"per_page": GITHUB_PER_PAGE, "page": page},
        )
        raise_for_github(resp, "read the pull request files")
        batch = resp.json()
        if not batch:
            break
        files.extend(batch)
        if len(batch) < GITHUB_PER_PAGE:
            break
        page += 1
    return files


def upsert_status_comment(
    client: httpx.Client,
    repo: str,
    pr_number: int,
    body: str,
) -> None:
    marked_body = f"{STATUS_COMMENT_MARKER}\n{body}"
    comments_url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    resp = client.get(comments_url, params={"per_page": GITHUB_PER_PAGE})
    raise_for_github(resp, "list pull request comments")
    existing_id: int | None = None
    for comment in resp.json():
        comment_body = comment.get("body") or ""
        if STATUS_COMMENT_MARKER in comment_body or LEGACY_STATUS_COMMENT_MARKER in comment_body:
            existing_id = int(comment["id"])
            break

    if existing_id is not None:
        patch_resp = client.patch(
            f"https://api.github.com/repos/{repo}/issues/comments/{existing_id}",
            json={"body": marked_body},
        )
        raise_for_github(patch_resp, "update the status comment")
    else:
        post_resp = client.post(comments_url, json={"body": marked_body})
        raise_for_github(post_resp, "post the status comment")


VIDEO_COMMENT_MAX_BYTES = 10_000_000


def post_ui_video_comment(
    token: str, repo: str, pr_number: int, head_sha: str, videos: list[tuple[int, Path]],
) -> str:
    if not videos:
        return "no_recordings"

    body = [f"### Recorded UI checks for `{head_sha[:7]}`"]
    args = ["gh", "pr", "comment", str(pr_number), "--repo", f"github.com/{repo}", "--body-file", "-"]
    attached = 0
    for flow, file in videos:
        try:
            size = file.stat().st_size
        except OSError:
            continue
        if not 0 < size <= VIDEO_COMMENT_MAX_BYTES:
            continue
        attached += 1
        body.extend(["", f"Workflow {flow}", "", f"![]({file})"])
        args.extend(("--attach", str(file)))

    if not attached:
        return "no_attachable_recordings"
    try:
        completed = subprocess.run(
            args, input="\n".join(body), text=True, capture_output=True, timeout=120,
            env={"PATH": os.environ.get("PATH", os.defpath),
                 "HOME": str(Path.home()), "GH_TOKEN": token, "GH_PROMPT_DISABLED": "1"},
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "upload_failed"
    if completed.returncode != 0:
        return "upload_failed"
    return "posted" if attached == len(videos) else "partially_posted"


def is_fork_pr(pr: dict[str, Any]) -> bool:
    """True when the head branch lives in another repository (or its repository was deleted)."""
    head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
    base_repo = ((pr.get("base") or {}).get("repo") or {}).get("full_name")
    return not head_repo or head_repo != base_repo


def submit_pr_review(
    client: httpx.Client,
    repo: str,
    pr_number: int,
    head_sha: str,
    review: dict[str, Any],
) -> dict[str, Any]:
    """Post a review built by `review.build_review`; auth failures raise GitHubAuthError."""
    reviews_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/reviews"
    payload = {
        "commit_id": head_sha,
        "body": review["body"],
        "event": review["verdict"],
        "comments": review["comments"],
    }

    resp = client.post(reviews_url, json=payload)
    if resp.status_code == 422 and payload["event"] == VERDICT_REQUEST_CHANGES:
        # GitHub rejects REQUEST_CHANGES when the token belongs to the PR author.
        payload["event"] = VERDICT_COMMENT
        resp = client.post(reviews_url, json=payload)

    if resp.status_code == 422 and payload["comments"]:
        payload["comments"] = []
        payload["body"] = body_with_inline_comments(review)
        resp = client.post(reviews_url, json=payload)

    raise_for_github(resp, "post the review")
    return resp.json()


REVIEW_THREADS_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved comments(first: 20) { nodes { body author { login __typename } } } }
      }
    }
  }
}
"""
WONT_FIX_PATTERN = re.compile(
    r"won[\'’]?t\s*fix|wontfix|false\s+positive|not\s+an?\s+(?:issue|problem|bug)",
    re.IGNORECASE,
)
FINDING_MARKER_PATTERN = re.compile(r"<!-- muse-finding:(?P<rule>[A-Za-z0-9.-]+) -->")
OUTCOME_WONT_FIX = "wont_fix"
OUTCOME_RESOLVED = "resolved"
OUTCOME_OPEN = "open"


def classify_review_threads(threads: list[dict[str, Any]]) -> list[dict[str, str]]:
    """One `{rule_id, outcome}` per reviewer thread; a human reply saying "won't fix" wins over resolved."""
    outcomes: list[dict[str, str]] = []
    for thread in threads:
        comments = ((thread.get("comments") or {}).get("nodes")) or []
        if not comments:
            continue
        marker = FINDING_MARKER_PATTERN.search(comments[0].get("body") or "")
        if not marker:
            continue
        human_replies = [
            comment.get("body") or ""
            for comment in comments[1:]
            if ((comment.get("author") or {}).get("__typename")) != "Bot"
        ]
        if any(WONT_FIX_PATTERN.search(reply) for reply in human_replies):
            outcome = OUTCOME_WONT_FIX
        elif thread.get("isResolved"):
            outcome = OUTCOME_RESOLVED
        else:
            outcome = OUTCOME_OPEN
        outcomes.append({"rule_id": marker.group("rule"), "outcome": outcome})
    return outcomes


def fetch_review_thread_outcomes(
    client: httpx.Client,
    repo: str,
    pr_number: int,
) -> list[dict[str, str]]:
    owner, name = repo.split("/", 1)
    resp = client.post(
        "https://api.github.com/graphql",
        json={
            "query": REVIEW_THREADS_QUERY,
            "variables": {"owner": owner, "name": name, "number": pr_number},
        },
    )
    raise_for_github(resp, "read review threads")
    data = (resp.json().get("data") or {}).get("repository") or {}
    threads = (((data.get("pullRequest") or {}).get("reviewThreads") or {}).get("nodes")) or []
    return classify_review_threads(threads)
