"""One PR review from start to finish, with the sandbox injected so the flow is testable offline."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from diff_index import DiffIndex
from github_api import (
    fetch_pr_details,
    fetch_pr_files,
    is_fork_pr,
    require_usable_token,
    submit_pr_review,
    upsert_status_comment,
)
from linear import fetch_issue_texts
from pipeline import STATUS_REVIEWED, STATUS_SKIPPED, RunState, SessionRun, assess
from prompts import (
    HANDS_ON_SESSION_PROFILE,
    REVIEW_SESSION_PROFILES,
    build_hands_on_prompt,
    build_session_prompt,
    hands_on_output_schema,
    session_output_schema,
)
from sandbox import SessionTask
from validation import cited_linear_issues

FORK_SKIP_REASON = "fork pull request: secrets are not exposed to fork code (ALLOW_FORK_PRS is off)"


@dataclass(frozen=True)
class Checkout:
    repo: str
    refs: list[str]
    commit: str
    diff_base: str
    tasks: list[SessionTask]


SandboxRunner = Callable[[Checkout], tuple[list[dict[str, Any]], list[SessionRun]]]


@dataclass(frozen=True)
class ReviewDeps:
    github_token: str
    model: str
    secret_env: dict[str, str]
    allow_forks: bool
    run_in_sandbox: SandboxRunner
    secrets: tuple[str, ...] = ()


def session_tasks(
    *,
    repo: str,
    pr_number: int,
    title: str,
    body: str,
    diff_base: str,
    changed_files: list[str],
    custom_instructions: str,
    include_hands_on: bool,
) -> list[SessionTask]:
    shared = {
        "repo": repo,
        "pr_number": pr_number,
        "title": title,
        "body": body,
        "diff_base": diff_base,
        "changed_files": changed_files,
        "custom_instructions": custom_instructions,
    }
    tasks = [
        SessionTask(
            session=profile.key,
            prompt=build_session_prompt(profile, **shared),
            schema=session_output_schema(profile.key),
            read_only=True,
            max_steps=profile.max_steps,
        )
        for profile in REVIEW_SESSION_PROFILES
    ]
    if include_hands_on:
        tasks.append(
            SessionTask(
                session=HANDS_ON_SESSION_PROFILE.key,
                prompt=build_hands_on_prompt(**shared),
                schema=hands_on_output_schema(),
                read_only=False,
                max_steps=HANDS_ON_SESSION_PROFILE.max_steps,
            )
        )
    return tasks


def review_pull_request(
    state: RunState,
    gh: httpx.Client,
    deps: ReviewDeps,
    custom_instructions: str = "",
) -> dict[str, Any]:
    """Fills `state` as it goes; GitHub auth failures propagate as GitHubAuthError (see run_and_record)."""
    repo, pr_number = state.repo, state.pr_number
    state.token_kind = require_usable_token(deps.github_token)
    pr = fetch_pr_details(gh, repo, pr_number)
    state.head_sha = pr["head"]["sha"]
    if is_fork_pr(pr) and not deps.allow_forks:
        # Comment triggers carry no head repository, so the webhook's fork check is repeated here.
        state.status = STATUS_SKIPPED
        state.error = FORK_SKIP_REASON
        return {"status": STATUS_SKIPPED, "run_id": state.run_id, "reason": FORK_SKIP_REASON}

    pr_files = fetch_pr_files(gh, repo, pr_number)
    diff = DiffIndex.from_pr_files(pr_files)
    base_ref = pr["base"]["ref"]
    diff_base = f"origin/{base_ref}"
    upsert_status_comment(
        gh,
        repo,
        pr_number,
        f"Review of `{state.head_sha[:7]}` is running: deterministic gates, then "
        f"{len(REVIEW_SESSION_PROFILES)} review sessions and a live app check (`{deps.model}`).",
    )

    tasks = session_tasks(
        repo=repo,
        pr_number=pr_number,
        title=pr.get("title") or "",
        body=pr.get("body") or "",
        diff_base=diff_base,
        changed_files=[item["filename"] for item in pr_files if item.get("filename")],
        custom_instructions=custom_instructions,
        include_hands_on=True,
    )
    checkout = Checkout(repo, [base_ref, state.head_sha], state.head_sha, diff_base, tasks)
    state.gates, state.session_runs = deps.run_in_sandbox(checkout)

    payloads = {run.session: run.output.payload for run in state.session_runs}
    with httpx.Client() as linear_client:
        linear_texts = fetch_issue_texts(
            linear_client,
            deps.secret_env.get("LINEAR_API_KEY", ""),
            cited_linear_issues(payloads),
        )
    result = assess(
        session_runs=state.session_runs,
        gates=state.gates,
        diff=diff,
        linear_texts=linear_texts,
        model=deps.model,
        secrets=deps.secrets,
    )
    state.validations = result.validations
    state.posted_findings = result.findings
    state.verdict = result.review["verdict"]

    submitted = submit_pr_review(gh, repo, pr_number, state.head_sha, result.review)
    state.review_id = submitted.get("id")
    state.status = STATUS_REVIEWED
    upsert_status_comment(
        gh,
        repo,
        pr_number,
        f"Review of `{state.head_sha[:7]}` posted: `{state.verdict}`, "
        f"{len(result.findings)} verified finding(s), run `{state.run_id}`.",
    )
    return {
        "status": STATUS_REVIEWED,
        "run_id": state.run_id,
        "verdict": state.verdict,
        "findings_count": len(result.findings),
        "session_errors": result.session_errors,
        "review_id": state.review_id,
    }
