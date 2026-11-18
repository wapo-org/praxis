from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
import modal
from fastapi import HTTPException, Request, status

import sandbox
from codex_runtime import MODEL, REASONING_EFFORT
from codex_session import prepare_codex, run_codex_session, run_codex_sessions, smoke_task
from github_api import (
    DEFAULT_ALLOWED_REPOS,
    fetch_review_thread_outcomes,
    github_headers,
    parse_webhook_event,
    post_ui_video_comment,
    require_usable_token,
    verify_github_signature,
)
from images import browser_image, codex_image, sandbox_image, web_image
from orchestrate import Checkout, ReviewDeps, review_pull_request, session_tasks
from pipeline import STATUS_REVIEWED, RunState, SessionRun, run_and_record
from report import DEFAULT_REPORT_RUNS, format_report, summarize_runs
from runlog import RUNS_MOUNT_PATH, RUNS_VOLUME_NAME, load_run_records, write_run_record
from ui_prompts import EMBER, UI_WORKSPACE, visual_task
from ui_review import run_hosted_ui_review
from vercel_preview import PreviewConfig

APP_NAME = "praxis-muse-pr-reviewer"
SECRET_NAME = "praxis-pr-reviewer-secrets"
CODEKEY_SECRET_NAME = "praxis-codekey-codex"
VERCEL_SECRET_NAME = "praxis-pr-reviewer-vercel"
MUSE_AUTH_VOLUME_NAME = "muse-auth-state"
MUSE_AUTH_MOUNT_PATH = "/mnt/muse-auth"
SANDBOX_CPU_CORES = 6.0
SANDBOX_MEMORY_MIB = 12288
# Worst case: install 600 s + gates 1020 s + sessions 900 s; typical runs finish far sooner.
SANDBOX_TIMEOUT_SECONDS = 2700
BROWSER_SANDBOX_TIMEOUT_SECONDS = 2100
FUNCTION_TIMEOUT_SECONDS = 4800
TRUTHY = {"1", "true", "yes"}

app = modal.App(APP_NAME)
muse_auth_vol = modal.Volume.from_name(MUSE_AUTH_VOLUME_NAME, create_if_missing=True, version=2)
runs_vol = modal.Volume.from_name(RUNS_VOLUME_NAME, create_if_missing=True, version=2)
reviewer_secret = modal.Secret.from_name(SECRET_NAME)
codekey_secret = modal.Secret.from_name(CODEKEY_SECRET_NAME)
vercel_secret = modal.Secret.from_name(VERCEL_SECRET_NAME)


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUTHY


def _allowed_repos() -> tuple[str, ...]:
    configured = [item.strip() for item in os.environ.get("ALLOWED_REPOS", "").split(",") if item.strip()]
    return tuple(configured) or DEFAULT_ALLOWED_REPOS


def _read_volume_file(name: str) -> str | None:
    path = Path(MUSE_AUTH_MOUNT_PATH) / name
    return path.read_text(encoding="utf-8") if path.exists() else None


def _codex_credentials() -> dict[str, str]:
    credentials = {"CODEKEY_API_KEY": os.environ["CODEKEY_API_KEY"]}
    if os.environ.get("LINEAR_API_KEY", "").strip():
        credentials["LINEAR_API_KEY"] = os.environ["LINEAR_API_KEY"]
    return credentials


def _configure_browser_muse(sb: modal.Sandbox, browser_env: dict[str, str]) -> str | None:
    muse_auth_vol.reload()
    auth_json = _read_volume_file("auth.json")
    if not auth_json and "META_API_KEY" not in browser_env:
        raise RuntimeError("Muse Code browser authentication is missing.")
    sandbox.configure_muse(
        sb, model=EMBER, reasoning_effort="medium", auth_json=auth_json,
        trust_json=_read_volume_file("trust.json"),
    )
    return auth_json


def _persist_browser_auth(sb: modal.Sandbox, original: str | None) -> None:
    refreshed = sandbox.read_refreshed_auth(sb)
    if not refreshed or refreshed == original:
        return
    muse_auth_vol.reload()
    if _read_volume_file("auth.json") == original:
        (Path(MUSE_AUTH_MOUNT_PATH) / "auth.json").write_text(refreshed, encoding="utf-8")
        muse_auth_vol.commit()


def _create_sandbox(
    image: modal.Image = sandbox_image, timeout: int = SANDBOX_TIMEOUT_SECONDS, *,
    runtime: Literal["vm", "gvisor"] | None = None,
) -> modal.Sandbox:
    """No secrets in the sandbox environment and no credential volume: sessions get them per process."""
    return modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=image,
        cpu=SANDBOX_CPU_CORES,
        memory=SANDBOX_MEMORY_MIB,
        timeout=timeout,
        runtime=runtime,
    )


def _persist(record: dict[str, Any]) -> None:
    write_run_record(RUNS_MOUNT_PATH, record)
    runs_vol.commit()


@app.function(image=web_image)
@modal.fastapi_endpoint(method="GET")
def health() -> dict[str, str]:
    return {"status": "ok", "app": "praxis-codex-pr-reviewer", "runtime": "codex",
            "model": MODEL, "reasoning": REASONING_EFFORT}


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
    secrets=[reviewer_secret, codekey_secret, vercel_secret],
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
    credentials = _codex_credentials()
    browser_env = {key: os.environ[key] for key in ("META_API_KEY",) if os.environ.get(key)}
    preview_config = PreviewConfig.from_env()
    secrets = (
        github_token,
        os.environ.get("GITHUB_WEBHOOK_SECRET", ""),
        *credentials.values(),
        *browser_env.values(),
        preview_config.token,
        preview_config.bypass_secret,
    )
    started = time.monotonic()
    state = RunState(
        run_id=uuid.uuid4().hex[:12],
        repo=repo,
        pr_number=pr_number,
        trigger=trigger_source,
        model=MODEL,
        reasoning_effort=REASONING_EFFORT,
        started_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )

    def populate(sb: modal.Sandbox, checkout: Checkout) -> None:
        sandbox.clone_repo(
            sb, repo=checkout.repo, refs=checkout.refs, checkout=checkout.commit, github_token=github_token,
        )

    def run_in_sandbox(checkout: Checkout) -> tuple[list[dict[str, Any]], list[SessionRun]]:
        gate_sandbox = _create_sandbox()
        try:
            populate(gate_sandbox, checkout)
            sandbox.install_dependencies(gate_sandbox)
            gates = sandbox.run_gates(gate_sandbox, checkout.diff_base)
        finally:
            gate_sandbox.terminate()

        source_sandbox = _create_sandbox(codex_image, runtime="vm")
        try:
            populate(source_sandbox, checkout)
            runs = run_codex_sessions(source_sandbox, checkout.tasks, credentials)
        finally:
            source_sandbox.terminate()
        return gates, runs

    def run_ui(current: RunState, plan: dict[str, Any] | None) -> tuple[dict[str, Any], list[SessionRun]]:
        artifact_path = Path(RUNS_MOUNT_PATH) / "ui-evidence" / current.run_id

        def configure_browser(sb: modal.Sandbox) -> str | None:
            return _configure_browser_muse(sb, browser_env)

        def create_browser() -> modal.Sandbox:
            return _create_sandbox(browser_image, BROWSER_SANDBOX_TIMEOUT_SECONDS)

        def review_images(manifest: list[dict[str, Any]], files: tuple[Path, ...]) -> SessionRun:
            sb = _create_sandbox(codex_image, timeout=600, runtime="vm")
            try:
                prepare_codex(sb)
                sandbox.exec_in(sb, "mkdir", "-p", UI_WORKSPACE)
                images = tuple(f"{UI_WORKSPACE}/image-{index}.jpg" for index in range(1, len(files) + 1))
                for source, target in zip(files, images, strict=True):
                    sb.filesystem.copy_from_local(source, target)
                return run_codex_session(
                    sb, visual_task(manifest, images), workspace=UI_WORKSPACE,
                    credentials={"CODEKEY_API_KEY": credentials["CODEKEY_API_KEY"]},
                )
            finally:
                sb.terminate()

        report, runs = run_hosted_ui_review(
            payload=plan, head_sha=current.head_sha, config=preview_config,
            create_sandbox=create_browser, configure_sandbox=configure_browser,
            persist_auth=_persist_browser_auth,
            review_images=review_images, secret_env=browser_env, destination=artifact_path,
        )
        if artifact_path.exists():
            report["artifacts"] = f"ui-evidence/{current.run_id}"
        return report, runs

    def publish_videos(current: RunState) -> str:
        root = Path(RUNS_MOUNT_PATH) / "ui-evidence" / current.run_id
        flows = (current.ui_review or {}).get("flows", [])
        videos = []
        for number, flow in enumerate(flows, 1):
            if not flow["video"]:
                continue
            directory = root / f"flow-{number}"
            file = directory / "workflow.mp4"
            videos.append((number, file if file.is_file() else directory / "workflow.webm"))
        return post_ui_video_comment(github_token, current.repo, current.pr_number, current.head_sha, videos)

    deps = ReviewDeps(
        github_token=github_token,
        model=MODEL,
        secret_env=credentials,
        allow_forks=_flag("ALLOW_FORK_PRS"),
        run_in_sandbox=run_in_sandbox,
        run_ui=run_ui,
        publish_videos=publish_videos,
        secrets=secrets,
    )

    def review(state: RunState) -> dict[str, Any]:
        with httpx.Client(headers=github_headers(github_token), timeout=30.0) as gh:
            return review_pull_request(state, gh, deps, custom_instructions)

    return run_and_record(state, review, _persist, elapsed=lambda: time.monotonic() - started, secrets=secrets)


@app.function(
    image=web_image,
    secrets=[reviewer_secret, codekey_secret],
    volumes={MUSE_AUTH_MOUNT_PATH: muse_auth_vol},
    timeout=FUNCTION_TIMEOUT_SECONDS,
)
def run_eval_case(case: dict[str, Any], repo: str) -> dict[str, Any]:
    """Run the reviewer on one eval fixture (new files committed on top of the default branch). Posts nothing."""
    github_token = os.environ["GITHUB_TOKEN"]
    credentials = _codex_credentials()
    files: dict[str, str] = case["files"]
    sb = _create_sandbox(codex_image, runtime="vm")
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
            include_ui_plan=False,
        )
        sandbox.install_dependencies(sb)
        gates = sandbox.run_gates(sb, "HEAD~1")
        runs = run_codex_sessions(sb, tasks, credentials)
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


@app.function(image=web_image, secrets=[codekey_secret], timeout=300)
def check_sandbox_environment() -> dict[str, Any]:
    sb = _create_sandbox(codex_image, timeout=250, runtime="vm")
    try:
        sandbox.exec_in(sb, "mkdir", "-p", sandbox.WORKSPACE)
        prepare_codex(sb)
        run = run_codex_session(sb, smoke_task(), credentials={"CODEKEY_API_KEY": os.environ["CODEKEY_API_KEY"]})
        if run.output.payload != {"ok": True}:
            raise RuntimeError(run.output.error or "codex_smoke_failed")
        return {"status": "validated", "model": MODEL, "reasoning": REASONING_EFFORT, "result": run.output.payload}
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
