from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request

import sandbox
from container_runtime import Sandbox
from github_api import DEFAULT_ALLOWED_REPOS, github_headers, parse_webhook_event, verify_github_signature
from orchestrate import Checkout, ReviewDeps, review_pull_request
from pipeline import RunState, run_and_record
from codex_session import DEFAULT_SOL_MODEL, DEFAULT_SOL_REASONING_EFFORT, configure_codex, read_codex_key, run_codex_sessions
from linear import LINEAR_READ_SCRIPT
from prompts import DEFAULT_MUSE_MODEL, DEFAULT_MUSE_REASONING_EFFORT
from stages import assess_with_sol, blocked_hands_on, run_preview_check, ui_requests
from runlog import write_run_record
from visual_review import (
    CONTACT_SHEET,
    CONTACT_SHEET_MAX_BYTES,
    DEVELOPMENT_VIDEO,
    DEVELOPMENT_VIDEO_MAX_BYTES,
    PNG_SIGNATURE,
    VISUAL_SESSION,
    WEBM_SIGNATURE,
    read_capture,
    retain_capture,
)

STATE = Path('/var/lib/praxis-review')
CREDENTIALS = Path('/etc/praxis-review/credentials.json')
AUTH_FILE = STATE / 'muse-auth.json'
QUEUE_PATH = STATE / 'queue.sqlite3'
RUNS = STATE / 'runs'
ARTIFACTS = STATE / 'review-artifacts'
WEBHOOK_MAX_BYTES = 2 * 1024 * 1024
QUEUE_INTERVAL_SECONDS = 2
GITHUB_TIMEOUT_SECONDS = 30
LOG = logging.getLogger('uvicorn.error')


def open_database():
    return closing(sqlite3.connect(QUEUE_PATH))


def _preview_secrets(config):
    keys = ('VERCEL_TOKEN', 'VERCEL_WEB_BYPASS_SECRET', 'VERCEL_API_BYPASS_SECRET', 'PREVIEW_TEST_EMAIL',
            'PREVIEW_TEST_PASSWORD')
    return tuple(config[key] for key in keys if config.get(key))


def _last_reviewed_head(repo, pr_number):
    pr_dir = RUNS / repo.replace('/', '_') / f'pr-{pr_number}'
    if not pr_dir.is_dir():
        return None
    for path in sorted(pr_dir.glob('*.json'), reverse=True):
        try:
            rec = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if rec.get('status') == 'reviewed' and rec.get('head_sha'):
            return str(rec['head_sha'])
    return None


def run_review(repo, pr, trigger, instructions, config, before_sha=''):
    token = config['GITHUB_TOKEN']
    env = {key: config[key] for key in ('LINEAR_API_KEY', 'META_API_KEY') if config.get(key)}
    sol_model = config.get('SOL_MODEL', DEFAULT_SOL_MODEL)
    sol_effort = config.get('SOL_REASONING_EFFORT', DEFAULT_SOL_REASONING_EFFORT)
    muse_model = config.get('MUSE_MODEL', DEFAULT_MUSE_MODEL)
    muse_effort = config.get('MUSE_REASONING_EFFORT', DEFAULT_MUSE_REASONING_EFFORT)
    codex_key = read_codex_key()
    if codex_key is None:
        raise RuntimeError('Codex Key credentials are unavailable')
    known = (token, config['GITHUB_WEBHOOK_SECRET'], *env.values(), *_preview_secrets(config), *codex_key.values())
    started = time.monotonic()
    state = RunState(uuid.uuid4().hex[:12], repo, pr, trigger, sol_model, sol_effort,
                     datetime.now(timezone.utc).isoformat())

    def checkout_repo(container, checkout):
        workspace = sandbox.WORKSPACE
        origin = f'https://github.com/{checkout.repo}.git'
        gate_base = checkout.gate_diff_base or checkout.diff_base
        base_ref = gate_base.removeprefix('origin/')
        fetch_refs = [f'refs/heads/{base_ref}:refs/remotes/origin/{base_ref}', checkout.commit]
        if checkout.diff_base and not checkout.diff_base.startswith('origin/') and checkout.diff_base != checkout.commit:
            fetch_refs.append(checkout.diff_base)
        sandbox.exec_in(container, 'git', 'clone', '--depth=50', origin, workspace)
        sandbox.exec_in(container, 'git', '-C', workspace, 'fetch', '--depth=50', 'origin', *fetch_refs)
        sandbox.exec_in(container, 'git', '-C', workspace, 'checkout', '--detach', checkout.commit)

    def preview_stage(container, checkout, requests):
        auth = AUTH_FILE.read_text(encoding='utf-8') if AUTH_FILE.is_file() else None
        if not auth and not env.get('META_API_KEY'):
            return blocked_hands_on('development_configuration', 'Muse authentication is unavailable.')
        sandbox.configure_muse(container, model=muse_model, reasoning_effort=muse_effort,
                               auth_json=auth, trust_json=None, with_linear=False)
        muse_env = {key: env[key] for key in ('META_API_KEY',) if key in env}
        hands_on, has_sheet = run_preview_check(container, checkout, requests, config, muse_model=muse_model,
                                                muse_effort=muse_effort, muse_env=muse_env)
        refreshed = sandbox.read_refreshed_auth(container)
        if refreshed and refreshed != auth:
            updated = AUTH_FILE.with_suffix('.new')
            updated.write_text(refreshed, encoding='utf-8')
            updated.chmod(0o600)
            updated.replace(AUTH_FILE)
        if not has_sheet:
            return hands_on
        try:
            sheet = read_capture(container, CONTACT_SHEET, CONTACT_SHEET_MAX_BYTES, PNG_SIGNATURE)
            recording = read_capture(container, DEVELOPMENT_VIDEO, DEVELOPMENT_VIDEO_MAX_BYTES, WEBM_SIGNATURE)
            if sheet is None:
                return hands_on
            destination = ARTIFACTS / state.run_id
            retain_capture(destination, CONTACT_SHEET, sheet)
            if recording is not None:
                retain_capture(destination, DEVELOPMENT_VIDEO, recording)
            hands_on.visual = assess_with_sol(container, requests, sheet=sheet, model=sol_model, effort=sol_effort,
                                              recording_retained=recording is not None)
        except Exception as error:
            LOG.warning('Visual assessment unavailable for run %s (%s).', state.run_id, type(error).__name__)
        return hands_on

    def run_sandboxes(checkout: Checkout):
        with Sandbox() as gates_container:
            checkout_repo(gates_container, checkout)
            sandbox.install_dependencies(gates_container)
            gates = sandbox.run_gates(gates_container, checkout.gate_diff_base or checkout.diff_base)
        with Sandbox() as model_container:
            checkout_repo(model_container, checkout)
            sandbox.exec_in(model_container, 'bash', '-lc',
                            'if [ -f /workspace/repo/cloud/package-lock.json ]; then '
                            'npm --prefix /workspace/repo/cloud ci --ignore-scripts --no-audit --no-fund; fi',
                            timeout=sandbox.DEPENDENCY_INSTALL_TIMEOUT_SECONDS)
            sandbox.write_file(model_container, '/usr/local/bin/linear-read', LINEAR_READ_SCRIPT, mode=0o755)
            configure_codex(model_container, codex_key, [task.session for task in checkout.tasks] + [VISUAL_SESSION])
            code_env = {key: env[key] for key in ('LINEAR_API_KEY',) if key in env}
            sessions = run_codex_sessions(model_container, checkout.tasks, model=sol_model,
                                          reasoning_effort=sol_effort, secret_env=code_env)
            requests = ui_requests(sessions)
            if requests:
                sessions.append(preview_stage(model_container, checkout, requests))
        return gates, sessions

    deps = ReviewDeps(github_token=token, model=sol_model, secret_env=env, allow_forks=False,
                      run_in_sandbox=run_sandboxes, secrets=known)

    effective_before = before_sha or (_last_reviewed_head(repo, pr) if trigger == 'pull_request:synchronize' else None)

    def review(current):
        with httpx.Client(headers=github_headers(token), timeout=GITHUB_TIMEOUT_SECONDS) as gh:
            return review_pull_request(current, gh, deps, instructions, before_sha=effective_before)

    return run_and_record(state, review, lambda record: write_run_record(RUNS, record),
                          elapsed=lambda: time.monotonic() - started, secrets=known)


def consume(stop, config):
    while not stop.is_set():
        with open_database() as db, db:
            job = db.execute(
                "SELECT id,repo,pr,trigger,instructions,before_sha FROM delivery WHERE status='queued' ORDER BY rowid LIMIT 1"
            ).fetchone()
            if job:
                db.execute("UPDATE delivery SET status='running' WHERE id=?", (job[0],))
        if not job:
            stop.wait(QUEUE_INTERVAL_SECONDS)
            continue
        delivery, repo, pr_num, trig, instr, before_sha = job
        try:
            result = run_review(repo, pr_num, trig, instr, config, before_sha=before_sha or '')
            status = result['status']
        except Exception as error:
            LOG.error('Review failed for delivery %s (%s). See private run record.', delivery, type(error).__name__)
            status = 'error'
        with open_database() as db, db:
            db.execute('UPDATE delivery SET status=? WHERE id=?', (status, delivery))


@asynccontextmanager
async def lifetime(app):
    config = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    if not all(config.get(key) for key in ('GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET')):
        raise RuntimeError('Reviewer GitHub credentials are incomplete')
    app.state.config = config
    RUNS.mkdir(mode=0o700, exist_ok=True)
    with open_database() as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('''CREATE TABLE IF NOT EXISTS delivery (
            id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL,
            trigger TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL,
            before_sha TEXT NOT NULL DEFAULT '')''')
        cols = {row[1] for row in db.execute('PRAGMA table_info(delivery)').fetchall()}
        if 'before_sha' not in cols:
            db.execute("ALTER TABLE delivery ADD COLUMN before_sha TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE delivery SET status='interrupted' WHERE status='running'")
    stop = threading.Event()
    worker = threading.Thread(target=consume, args=(stop, config), daemon=True, name='review-worker')
    worker.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(lifespan=lifetime, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/github')
async def github(request: Request):
    body = bytearray()
    async for block in request.stream():
        body.extend(block)
        if len(body) > WEBHOOK_MAX_BYTES:
            raise HTTPException(413, 'Webhook payload too large')
    config = request.app.state.config
    if not verify_github_signature(body, request.headers.get('X-Hub-Signature-256'), config['GITHUB_WEBHOOK_SECRET']):
        raise HTTPException(401, 'Invalid webhook signature')
    event = request.headers.get('X-GitHub-Event', '')
    if event == 'ping':
        return {'status': 'pong'}
    try:
        delivery = str(uuid.UUID(request.headers.get('X-GitHub-Delivery', '')))
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError('Invalid payload')
        trigger, reason = parse_webhook_event(
            event, payload, review_drafts=config.get('REVIEW_DRAFT_PRS', '').lower() in {'1', 'yes', 'true'},
            allow_forks=False, allowed_repos=DEFAULT_ALLOWED_REPOS,
        )
    except (TypeError, ValueError, KeyError, AttributeError):
        raise HTTPException(400, 'Invalid webhook payload') from None
    if trigger is None:
        return {'status': 'ignored', 'reason': reason}
    with open_database() as db, db:
        inserted = db.execute(
            'INSERT OR IGNORE INTO delivery (id, repo, pr, trigger, instructions, status, before_sha) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (delivery, trigger.repo_full_name, trigger.pr_number, trigger.trigger_source,
             trigger.custom_instructions, 'queued', trigger.before_sha or ''),
        ).rowcount
    return {'status': 'queued' if inserted else 'duplicate', 'delivery': delivery}
