from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import modal
from fastapi import HTTPException, Request, status

import sandbox
from github_api import (
    DEFAULT_ALLOWED_REPOS,
    fetch_review_thread_outcomes,
    github_headers,
    parse_webhook_event,
    require_usable_token,
    verify_github_signature,
)
from images import sandbox_image, web_image
from orchestrate import Checkout, ReviewDeps, review_pull_request, session_tasks
from pipeline import STATUS_REVIEWED, RunState, SessionRun, run_and_record
from prompts import DEFAULT_MUSE_MODEL, DEFAULT_MUSE_REASONING_EFFORT, installed_skills
from report import DEFAULT_REPORT_RUNS, format_report, summarize_runs
from runlog import RUNS_MOUNT_PATH, RUNS_VOLUME_NAME, load_run_records, write_run_record

APP_NAME = "praxis-muse-pr-reviewer"
SECRET_NAME = "praxis-pr-reviewer-secrets"
MUSE_AUTH_VOLUME_NAME = "muse-auth-state"
MUSE_AUTH_MOUNT_PATH = "/mnt/muse-auth"
SANDBOX_CPU_CORES = 6.0
SANDBOX_MEMORY_MIB = 12288
# Worst case: install 600 s + gates 1020 s + sessions 900 s; typical runs finish far sooner.
SANDBOX_TIMEOUT_SECONDS = 2700
FUNCTION_TIMEOUT_SECONDS = 3000
TRUTHY = {"1", "true", "yes"}

app = modal.App(APP_NAME)
muse_auth_vol = modal.Volume.from_name(MUSE_AUTH_VOLUME_NAME, create_if_missing=True, version=2)
runs_vol = modal.Volume.from_name(RUNS_VOLUME_NAME, create_if_missing=True, version=2)
reviewer_secret = modal.Secret.from_name(SECRET_NAME)


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUTHY


def _allowed_repos() -> tuple[str, ...]:
    configured = [item.strip() for item in os.environ.get("ALLOWED_REPOS", "").split(",") if item.strip()]
    return tuple(configured) or DEFAULT_ALLOWED_REPOS


def _read_volume_file(name: str) -> str | None:
    path = Path(MUSE_AUTH_MOUNT_PATH) / name
    return path.read_text(encoding="utf-8") if path.exists() else None


def _muse_settings() -> tuple[str, str, dict[str, str]]:
    model = os.environ.get("MUSE_MODEL", "").strip() or DEFAULT_MUSE_MODEL
    effort = os.environ.get("MUSE_REASONING_EFFORT", "").strip() or DEFAULT_MUSE_REASONING_EFFORT
    secret_env = {
        name: os.environ[name].strip()
        for name in ("META_API_KEY", "LINEAR_API_KEY")
        if os.environ.get(name, "").strip()
    }
    return model, effort, secret_env


def _run_in_sandbox(
    sb: modal.Sandbox,
    *,
    diff_base: str,
    tasks: list[sandbox.SessionTask],
    model: str,
    effort: str,
    secret_env: dict[str, str],
) -> tuple[list[dict[str, Any]], list[SessionRun]]:
    """Order matters: PR-controlled code (install, gates) runs before any credential enters the sandbox."""
    sandbox.install_dependencies(sb)
    gates = sandbox.run_gates(sb, diff_base)

    muse_auth_vol.reload()
    auth_json = _read_volume_file("auth.json")
    if not auth_json and "META_API_KEY" not in secret_env:
        raise RuntimeError(
            "Muse Code is not authenticated in Modal: run scripts/sync-muse-auth.sh "
            "or set META_API_KEY in the reviewer secret."
        )
    sandbox.configure_muse(
        sb,
        model=model,
        reasoning_effort=effort,
        auth_json=auth_json,
        trust_json=_read_volume_file("trust.json"),
        with_linear="LINEAR_API_KEY" in secret_env,
    )
    runs = sandbox.run_sessions(sb, tasks, model=model, reasoning_effort=effort, secret_env=secret_env)

    refreshed = sandbox.read_refreshed_auth(sb)
    if refreshed and refreshed != auth_json:
        (Path(MUSE_AUTH_MOUNT_PATH) / "auth.json").write_text(refreshed, encoding="utf-8")
        muse_auth_vol.commit()
    return gates, runs


def _create_sandbox() -> modal.Sandbox:
    """No secrets in the sandbox environment and no credential volume: sessions get them per process."""
    return modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=sandbox_image,
        cpu=SANDBOX_CPU_CORES,
        memory=SANDBOX_MEMORY_MIB,
        timeout=SANDBOX_TIMEOUT_SECONDS,
    )


def _persist(record: dict[str, Any]) -> None:
    write_run_record(RUNS_MOUNT_PATH, record)
    runs_vol.commit()


@app.function(image=web_image)
@modal.fastapi_endpoint(method="GET")
def health() -> dict[str, str]:
    return {"status": "ok", "app": APP_NAME}


@app.function(image=web_image, secrets=[reviewer_secret])
@modal.fastapi_endpoint(method="POST")
async def github_webhook(request: Request) -> dict[str, Any]:
    raw_body = await request.body()
    webhook_secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
    if not webhook_secret:
        # An empty HMAC key would let anyone sign a payload.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="webhook secret not configured")
    if not verify_github_signature(raw_body, request.headers.get("X-Hub-Signature-256"), webhook_secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid X-Hub-Signature-256")

    event_type = request.headers.get("X-GitHub-Event", "")
    if event_type == "ping":
        return {"status": "pong"}

    trigger, reason = parse_webhook_event(
        event_type,
        json.loads(raw_body),
        review_drafts=_flag("REVIEW_DRAFT_PRS"),
        allow_forks=_flag("ALLOW_FORK_PRS"),
        allowed_repos=_allowed_repos(),
    )
    if trigger is None:
        return {"status": "ignored", "reason": reason}

    call = run_pr_review.spawn(
        repo=trigger.repo_full_name,
        pr_number=trigger.pr_number,
        trigger_source=trigger.trigger_source,
        custom_instructions=trigger.custom_instructions,
    )
    return {
        "status": "queued",
        "repo": trigger.repo_full_name,
        "pr_number": trigger.pr_number,
        "trigger": trigger.trigger_source,
        "call_id": call.object_id,
    }


@app.function(
    image=web_image,
    secrets=[reviewer_secret],
    volumes={MUSE_AUTH_MOUNT_PATH: muse_auth_vol, RUNS_MOUNT_PATH: runs_vol},
    timeout=FUNCTION_TIMEOUT_SECONDS,
)
def run_pr_review(
    repo: str,
    pr_number: int,
    trigger_source: str = "manual",
    custom_instructions: str = "",
) -> dict[str, Any]:
    github_token = os.environ["GITHUB_TOKEN"]
    model, effort, secret_env = _muse_settings()
    secrets = (github_token, os.environ.get("GITHUB_WEBHOOK_SECRET", ""), *secret_env.values())
    started = time.monotonic()
    state = RunState(
        run_id=uuid.uuid4().hex[:12],
        repo=repo,
        pr_number=pr_number,
        trigger=trigger_source,
        model=model,
        reasoning_effort=effort,
        started_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )

    def run_in_sandbox(checkout: Checkout) -> tuple[list[dict[str, Any]], list[SessionRun]]:
        sb = _create_sandbox()
        try:
            sandbox.clone_repo(
                sb,
                repo=checkout.repo,
                refs=checkout.refs,
                checkout=checkout.commit,
                github_token=github_token,
            )
            return _run_in_sandbox(
                sb,
                diff_base=checkout.diff_base,
                tasks=checkout.tasks,
                model=model,
                effort=effort,
                secret_env=secret_env,
            )
        finally:
            sb.terminate()

    deps = ReviewDeps(
        github_token=github_token,
        model=model,
        secret_env=secret_env,
        allow_forks=_flag("ALLOW_FORK_PRS"),
        run_in_sandbox=run_in_sandbox,
        secrets=secrets,
    )

    def review(state: RunState) -> dict[str, Any]:
        with httpx.Client(headers=github_headers(github_token), timeout=30.0) as gh:
            return review_pull_request(state, gh, deps, custom_instructions)

    return run_and_record(state, review, _persist, elapsed=lambda: time.monotonic() - started, secrets=secrets)


@app.function(
    image=web_image,
    secrets=[reviewer_secret],
    volumes={MUSE_AUTH_MOUNT_PATH: muse_auth_vol},
    timeout=FUNCTION_TIMEOUT_SECONDS,
)
def run_eval_case(case: dict[str, Any], repo: str) -> dict[str, Any]:
    """Run the reviewer on one eval fixture (new files committed on top of the default branch). Posts nothing."""
    github_token = os.environ["GITHUB_TOKEN"]
    model, effort, secret_env = _muse_settings()
    files: dict[str, str] = case["files"]
    sb = _create_sandbox()
    try:
        sandbox.clone_repo(sb, repo=repo, refs=[], checkout="HEAD", github_token=github_token)
        for path, content in files.items():
            sandbox.write_file(sb, f"{sandbox.WORKSPACE}/{path}", content)
        sandbox.exec_in(
            sb,
            "bash",
            "-lc",
            f"cd {sandbox.WORKSPACE} && git add -A && git -c user.name=eval -c user.email=eval@example.invalid "
            "commit -qm 'eval fixture'",
        )
        tasks = session_tasks(
            repo=repo,
            pr_number=0,
            title=case.get("pr_title", ""),
            body=case.get("pr_body", ""),
            diff_base="HEAD~1",
            changed_files=sorted(files),
            custom_instructions="",
            include_hands_on=False,
        )
        gates, runs = _run_in_sandbox(
            sb, diff_base="HEAD~1", tasks=tasks, model=model, effort=effort, secret_env=secret_env
        )
    finally:
        sb.terminate()

    return {
        "name": case["name"],
        "gates": gates,
        "sessions": {run.session: run.output.payload for run in runs},
        "session_errors": {run.session: run.output.error for run in runs if run.output.error},
    }


@app.function(image=web_image, secrets=[reviewer_secret], volumes={RUNS_MOUNT_PATH: runs_vol}, timeout=300)
def collect_slop_report(limit: int = DEFAULT_REPORT_RUNS, with_threads: bool = True) -> dict[str, Any]:
    runs_vol.reload()
    records = load_run_records(RUNS_MOUNT_PATH, limit)
    outcomes: list[dict[str, str]] | None = None
    if with_threads:
        outcomes = []
        reviewed = {(r["repo"], r["pr_number"]) for r in records if r.get("status") == STATUS_REVIEWED}
        with httpx.Client(headers=github_headers(os.environ["GITHUB_TOKEN"]), timeout=30.0) as gh:
            for repo, pr_number in sorted(reviewed):
                outcomes.extend(fetch_review_thread_outcomes(gh, repo, pr_number))
    return summarize_runs(records, outcomes)


@app.function(image=web_image, secrets=[reviewer_secret], volumes={MUSE_AUTH_MOUNT_PATH: muse_auth_vol}, timeout=300)
def check_sandbox_environment() -> dict[str, Any]:
    """Report tool versions and credential presence; never returns secret material."""
    muse_auth_vol.reload()
    auth_json = _read_volume_file("auth.json")
    sb = modal.Sandbox.create("sleep", "infinity", app=app, image=sandbox_image, timeout=180)
    try:
        def srun(command: str) -> str:
            _, out, _ = sandbox.exec_in(sb, "bash", "-lc", command)
            return out.strip()

        return {
            "node": srun("node --version"),
            "npm": srun("npm --version"),
            "git": srun("git --version"),
            "gh": srun("gh --version | head -n1"),
            "muse": srun("muse --version"),
            "default_model": os.environ.get("MUSE_MODEL") or DEFAULT_MUSE_MODEL,
            "installed_skills": srun("ls -1 /opt/muse-skills").splitlines(),
            "expected_skills": list(installed_skills()),
            "chromium_binary": srun("find /opt/ms-playwright -name chrome -o -name headless_shell | head -n5"),
            "github_token_kind": require_usable_token(os.environ["GITHUB_TOKEN"]),
            "linear_key_present": bool(os.environ.get("LINEAR_API_KEY", "").strip()),
            "muse_auth_present": bool(auth_json),
            "muse_auth_sha256_prefix": hashlib.sha256(auth_json.encode()).hexdigest()[:8] if auth_json else None,
        }
    finally:
        sb.terminate()


@app.local_entrypoint()
def smoke_sandbox() -> None:
    """Run a quick health check inside the Modal sandbox image."""
    print(json.dumps(check_sandbox_environment.remote(), indent=2))


@app.local_entrypoint()
def review_pr(repo: str, pr: int, instructions: str = "") -> None:
    """Manually trigger a PR review in Modal for testing or re-runs."""
    result = run_pr_review.remote(
        repo=repo,
        pr_number=pr,
        trigger_source="manual_cli",
        custom_instructions=instructions,
    )
    print(json.dumps(result, indent=2))


@app.local_entrypoint()
def slop_report(limit: int = DEFAULT_REPORT_RUNS, threads: bool = True) -> None:
    """Summarise the last N persisted runs: drop rates, rule frequency, won't-fix share."""
    print(format_report(collect_slop_report.remote(limit=limit, with_threads=threads)))


@app.local_entrypoint()
def run_evals(repo: str = DEFAULT_ALLOWED_REPOS[0]) -> None:
    """Run the eval fixtures against the live model and print precision and recall. Costs model calls."""
    from evals.harness import format_scores, load_cases, predictions_from_run, score_cases

    cases = load_cases()
    results = list(run_eval_case.map([case.raw for case in cases], kwargs={"repo": repo}))
    by_name = {result["name"]: result for result in results}
    predictions = {case.name: predictions_from_run(case, by_name[case.name]) for case in cases}
    print(format_scores(score_cases(cases, predictions)))
