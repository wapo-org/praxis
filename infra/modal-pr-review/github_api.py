from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Any

import httpx

STATUS_COMMENT_MARKER = "<!-- muse-pr-review-status -->"
COMMAND_PATTERN = re.compile(
    r"(?:^|\s)(?:/muse|@muse-review)\b(?P<instructions>.*)$",
    re.IGNORECASE | re.DOTALL,
)
HUNK_HEADER_PATTERN = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")

GITHUB_API_VERSION = "2022-11-28"
GITHUB_PER_PAGE = 100
NON_COMMENT_VERDICTS = {"APPROVE", "REQUEST_CHANGES"}


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
) -> tuple[ReviewTrigger | None, str]:
    repo = payload.get("repository") or {}
    repo_full_name = repo.get("full_name")
    if not repo_full_name:
        return None, "missing repository.full_name"

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


def parse_diff_right_lines(patch: str | None) -> set[int]:
    if not patch:
        return set()
    valid_lines: set[int] = set()
    right_line = 0
    in_hunk = False

    for raw_line in patch.splitlines():
        hunk_match = HUNK_HEADER_PATTERN.match(raw_line)
        if hunk_match:
            right_line = int(hunk_match.group(1))
            in_hunk = True
            continue
        if not in_hunk:
            continue
        if raw_line.startswith("+"):
            valid_lines.add(right_line)
            right_line += 1
        elif raw_line.startswith("-") or raw_line.startswith("\\"):
            continue
        else:
            valid_lines.add(right_line)
            right_line += 1

    return valid_lines


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
    resp.raise_for_status()
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
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        files.extend(batch)
        if len(batch) < GITHUB_PER_PAGE:
            break
        page += 1
    return files


def build_diff_line_map(pr_files: list[dict[str, Any]]) -> dict[str, set[int]]:
    return {
        item["filename"]: parse_diff_right_lines(item.get("patch"))
        for item in pr_files
        if item.get("filename")
    }


def upsert_status_comment(
    client: httpx.Client,
    repo: str,
    pr_number: int,
    body: str,
) -> None:
    marked_body = f"{STATUS_COMMENT_MARKER}\n{body}"
    comments_url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    resp = client.get(comments_url, params={"per_page": GITHUB_PER_PAGE})
    resp.raise_for_status()
    existing_id: int | None = None
    for comment in resp.json():
        if STATUS_COMMENT_MARKER in (comment.get("body") or ""):
            existing_id = int(comment["id"])
            break

    if existing_id is not None:
        patch_resp = client.patch(
            f"https://api.github.com/repos/{repo}/issues/comments/{existing_id}",
            json={"body": marked_body},
        )
        patch_resp.raise_for_status()
    else:
        post_resp = client.post(comments_url, json={"body": marked_body})
        post_resp.raise_for_status()


def merge_session_reviews(
    session_results: list[dict[str, Any]],
    hands_on_result: dict[str, Any] | None,
    session_errors: list[str] | None = None,
) -> dict[str, Any]:
    """Synthesize parallel specialized sessions into one cohesive, non-opinionated review."""
    summaries: list[str] = []
    linear_seen: dict[str, dict[str, str]] = {}
    findings_seen: dict[tuple[str, int | None, str], dict[str, Any]] = {}
    has_blocking = False

    for res in session_results:
        session_key = str(res.get("session") or "review")
        summary_text = str(res.get("summary") or "").strip()
        if summary_text:
            summaries.append(f"- **{session_key}:** {summary_text}")

        if res.get("blocking_issues"):
            has_blocking = True

        for lc in res.get("linear_checks") or []:
            issue_id = str(lc.get("issue_id") or "").strip()
            if not issue_id:
                continue
            status = str(lc.get("status") or "not_applicable")
            note = str(lc.get("note") or "").strip()
            if status == "contradiction":
                has_blocking = True
            prior = linear_seen.get(issue_id)
            if prior is None or status in {"contradiction", "concern"}:
                linear_seen[issue_id] = {
                    "issue_id": issue_id,
                    "status": status,
                    "note": note,
                }

        for finding in res.get("findings") or []:
            _add_finding(findings_seen, finding, session_key)
            if finding.get("tone") == "hard_boundary_flag" and finding.get("severity") in {
                "critical",
                "major",
            }:
                has_blocking = True

    if hands_on_result:
        if hands_on_result.get("checks_failed"):
            has_blocking = True
        for finding in hands_on_result.get("findings") or []:
            _add_finding(findings_seen, finding, "hands_on")
            if finding.get("severity") in {"critical", "major"}:
                has_blocking = True

    if session_errors:
        summaries.append(
            "- **session_warnings:** Some review sessions hit errors: "
            + "; ".join(session_errors)
        )

    verdict = "REQUEST_CHANGES" if has_blocking else "COMMENT"
    return {
        "verdict": verdict,
        "summary": "\n".join(summaries) if summaries else "Review completed.",
        "linear_checks": list(linear_seen.values()),
        "hands_on_testing": hands_on_result
        or {
            "ran": False,
            "environment": "Modal Sandbox (Linux)",
            "checks_passed": [],
            "checks_failed": [],
            "manual_observations": "Hands-on verification did not return structured results.",
        },
        "findings": list(findings_seen.values()),
    }


def _add_finding(
    findings_seen: dict[tuple[str, int | None, str], dict[str, Any]],
    finding: dict[str, Any],
    session_key: str,
) -> None:
    path = finding.get("path") or ""
    line = finding.get("line") if isinstance(finding.get("line"), int) else None
    norm_title = re.sub(r"\s+", " ", str(finding.get("title") or "").strip().lower())
    key = (path, line, norm_title)
    enriched = {**finding, "sessions": [session_key]}
    existing = findings_seen.get(key)
    if existing is None:
        findings_seen[key] = enriched
    elif session_key not in existing["sessions"]:
        existing["sessions"].append(session_key)


def format_review_markdown(
    review: dict[str, Any],
    extra_findings: list[dict[str, Any]],
) -> str:
    verdict = review.get("verdict", "COMMENT")
    verdict_badge = {
        "APPROVE": "APPROVE",
        "REQUEST_CHANGES": "REQUEST CHANGES",
        "COMMENT": "COMMENT",
    }.get(verdict, verdict)

    lines: list[str] = [
        f"## Muse Code PR Review (`muse-ember-1.0` / `max`) — `{verdict_badge}`",
        "",
        review.get("summary", "").strip(),
    ]

    linear_checks = review.get("linear_checks") or []
    if linear_checks:
        lines.extend(["", "### Linear (`PRA`) Alignment"])
        for lc in linear_checks:
            lines.append(
                f"- **{lc.get('issue_id')}** (`{lc.get('status')}`): {lc.get('note', '').strip()}"
            )

    testing = review.get("hands_on_testing") or {}
    lines.extend(["", "### Hands-On App Testing"])
    ran = testing.get("ran", False)
    env_desc = testing.get("environment") or "Modal Sandbox (Linux)"
    lines.append(f"- **Executed:** {'Yes' if ran else 'No'} ({env_desc})")

    passed = testing.get("checks_passed") or []
    failed = testing.get("checks_failed") or []
    if passed:
        lines.append("- **Passed:**")
        for item in passed:
            lines.append(f"  - `{item}`")
    if failed:
        lines.append("- **Failed:**")
        for item in failed:
            lines.append(f"  - `{item}`")

    observations = (testing.get("manual_observations") or "").strip()
    if observations:
        lines.extend(["", observations])

    if extra_findings:
        lines.extend(["", "### Findings & Offers (Cross-File / General)"])
        for finding in extra_findings:
            lines.append(_format_finding_bullet(finding))

    return "\n".join(lines).strip()


def _format_finding_bullet(finding: dict[str, Any]) -> str:
    sev = str(finding.get("severity", "minor")).upper()
    sessions = ",".join(finding.get("sessions") or [])
    tag = f"[{sessions}] " if sessions else ""
    path = finding.get("path") or "<cross-file>"
    line = finding.get("line")
    loc = f"`{path}:{line}`" if line else f"`{path}`"
    ref = f" *(ref: `{finding['rule_or_issue']}`)*" if finding.get("rule_or_issue") else ""
    title = finding.get("title", "Finding")
    body = (finding.get("body") or "").strip()
    out = f"- **{tag}[{sev}] {title}** ({loc}{ref}): {body}"
    suggestion = (finding.get("suggestion") or "").strip()
    if suggestion:
        out += f"\n  - *Option / suggestion:* {suggestion}"
    return out


def submit_pr_review(
    client: httpx.Client,
    repo: str,
    pr_number: int,
    head_sha: str,
    review: dict[str, Any],
    diff_line_map: dict[str, set[int]],
) -> dict[str, Any]:
    inline_comments: list[dict[str, Any]] = []
    extra_findings: list[dict[str, Any]] = []

    for finding in review.get("findings") or []:
        path = finding.get("path")
        line = finding.get("line")
        valid_lines = diff_line_map.get(path or "", set())
        if path and isinstance(line, int) and line in valid_lines:
            sev = str(finding.get("severity", "minor")).upper()
            sessions = ",".join(finding.get("sessions") or [])
            tag = f"[{sessions}] " if sessions else ""
            title = finding.get("title", "Finding")
            body = (finding.get("body") or "").strip()
            suggestion = (finding.get("suggestion") or "").strip()
            ref = finding.get("rule_or_issue")
            parts = [f"**{tag}[{sev}] {title}**"]
            if ref:
                parts.append(f"*Ref: `{ref}`*")
            parts.extend(["", body])
            if suggestion:
                parts.extend(["", f"**Option / suggestion:** {suggestion}"])
            inline_comments.append(
                {
                    "path": path,
                    "line": line,
                    "side": "RIGHT",
                    "body": "\n".join(parts),
                }
            )
        else:
            extra_findings.append(finding)

    body = format_review_markdown(review, extra_findings)
    desired_event = review.get("verdict", "COMMENT")
    if desired_event not in {"APPROVE", "REQUEST_CHANGES", "COMMENT"}:
        desired_event = "COMMENT"

    reviews_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}/reviews"
    payload = {
        "commit_id": head_sha,
        "body": body,
        "event": desired_event,
        "comments": inline_comments,
    }

    resp = client.post(reviews_url, json=payload)
    if resp.status_code == 422 and desired_event in NON_COMMENT_VERDICTS:
        # GitHub rejects APPROVE/REQUEST_CHANGES when the token belongs to the PR author.
        payload["event"] = "COMMENT"
        resp = client.post(reviews_url, json=payload)

    if resp.status_code == 422 and inline_comments:
        payload["comments"] = []
        payload["body"] = format_review_markdown(review, list(review.get("findings") or []))
        resp = client.post(reviews_url, json=payload)

    resp.raise_for_status()
    return resp.json()
