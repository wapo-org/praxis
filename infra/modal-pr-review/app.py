from __future__ import annotations

import json
import os
import shlex
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import httpx
import modal
from fastapi import HTTPException, Request, status

from github_api import (
    build_diff_line_map,
    fetch_pr_details,
    fetch_pr_files,
    github_headers,
    merge_session_reviews,
    parse_webhook_event,
    submit_pr_review,
    upsert_status_comment,
    verify_github_signature,
)
from prompts import (
    DEFAULT_MUSE_MAX_MODEL_STEPS,
    DEFAULT_MUSE_MODEL,
    DEFAULT_MUSE_REASONING_EFFORT,
    HANDS_ON_OUTPUT_SCHEMA,
    INSTALLED_PSTACK_SKILLS,
    REVIEW_SESSION_OUTPUT_SCHEMA,
    REVIEW_SESSION_PROFILES,
    SessionProfile,
    build_hands_on_prompt,
    build_session_prompt,
)

APP_NAME = "praxis-muse-pr-reviewer"
SECRET_NAME = "praxis-pr-reviewer-secrets"
MUSE_AUTH_VOLUME_NAME = "muse-auth-state"
PLAYWRIGHT_VERSION = "1.64.1"
LINEAR_READONLY_MCP_URL = "https://mcp.linear.app/mcp/readonly"
SANDBOX_CPU_CORES = 6.0
SANDBOX_MEMORY_MIB = 12288
SANDBOX_TIMEOUT_SECONDS = 1800
FUNCTION_TIMEOUT_SECONDS = 2100
SESSION_EXEC_TIMEOUT_SECONDS = 900
MAX_PARALLEL_SESSIONS = 6

LINEAR_READ_SCRIPT = """#!/usr/bin/env python3
import json
import os
import sys
import urllib.request

key = os.environ.get("LINEAR_API_KEY", "").strip()
if not key:
    print("LINEAR_API_KEY is not set", file=sys.stderr)
    sys.exit(1)

args = sys.argv[1:]
if not args or args[0] in ("-h", "--help"):
    print("Usage: linear-read <PRA-123 | list [limit] | search <text> | graphql <query>>")
    sys.exit(0)

cmd = args[0]
if cmd.upper().startswith("PRA-"):
    num = int(cmd.split("-", 1)[1])
    query = '''
    query($num: Float!) {
      issues(first: 1, filter: { team: { key: { eq: "PRA" } }, number: { eq: $num } }) {
        nodes {
          identifier title priority state { name type }
          labels { nodes { name } }
          parent { identifier title }
          children(first: 20) { nodes { identifier title state { name } } }
          description
          comments(first: 20) { nodes { body user { name } createdAt } }
        }
      }
    }'''
    variables = {"num": num}
elif cmd == "list":
    limit = int(args[1]) if len(args) > 1 else 30
    query = f'''
    query {{
      issues(first: {limit}, orderBy: updatedAt, filter: {{ team: {{ key: {{ eq: "PRA" }} }} }}) {{
        nodes {{ identifier title state {{ name }} labels {{ nodes {{ name }} }} parent {{ identifier }} }}
      }}
    }}'''
    variables = {}
elif cmd == "search" and len(args) > 1:
    term = " ".join(args[1:])
    query = '''
    query($term: String!) {
      issueSearch(query: $term, first: 20) {
        nodes { identifier title state { name } description }
      }
    }'''
    variables = {"term": term}
elif cmd == "graphql" and len(args) > 1:
    query = args[1]
    if "mutation" in query.lower():
        print("Read-only tool: mutations are forbidden.", file=sys.stderr)
        sys.exit(2)
    variables = json.loads(args[2]) if len(args) > 2 else {}
else:
    print("Unknown command. Run linear-read --help", file=sys.stderr)
    sys.exit(2)

req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
    headers={"Authorization": key, "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=20) as resp:
    print(resp.read().decode("utf-8"))
"""

app = modal.App(APP_NAME)
muse_auth_vol = modal.Volume.from_name(
    MUSE_AUTH_VOLUME_NAME,
    create_if_missing=True,
    version=2,
)

web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]>=0.115.0", "httpx>=0.28.0")
    .add_local_python_source("github_api", "prompts")
)

_SKILLS_SPARSE_ARGS = " ".join(f"pstack/skills/{s}" for s in INSTALLED_PSTACK_SKILLS)

sandbox_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "bash",
        "ca-certificates",
        "curl",
        "git",
        "gnupg",
        "jq",
        "lsof",
        "procps",
        "ripgrep",
        "xz-utils",
    )
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y --no-install-recommends nodejs",
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
        "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        "chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] '
        'https://cli.github.com/packages stable main" '
        "> /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y --no-install-recommends gh",
        "rm -rf /var/lib/apt/lists/*",
        f"PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright@{PLAYWRIGHT_VERSION} install chromium --with-deps",
        "curl -fsSL https://dev.meta.ai/install.sh | bash",
        "ln -sf /root/.local/bin/muse /usr/local/bin/muse",
        "muse --version",
        # Install selected cursor/plugins pstack skills into /opt/muse-skills
        "git clone --depth=1 --filter=blob:none --sparse https://github.com/cursor/plugins.git /tmp/cursor-plugins",
        f"cd /tmp/cursor-plugins && git sparse-checkout set {_SKILLS_SPARSE_ARGS}",
        "mkdir -p /opt/muse-skills && cp -r /tmp/cursor-plugins/pstack/skills/* /opt/muse-skills/ && rm -rf /tmp/cursor-plugins",
    )
    .env(
        {
            "PATH": "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright",
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
            "TBH_CREDENTIAL_BACKEND": "file",
            "XDG_CONFIG_HOME": "/root/.config",
            "HOME": "/root",
        }
    )
)


def _exec(
    sb: modal.Sandbox,
    *args: str,
    env: dict[str, str | None] | None = None,
    workdir: str | None = None,
    timeout: int | None = None,
    check: bool = True,
) -> tuple[int, str, str]:
    proc = sb.exec(*args, env=env, workdir=workdir, timeout=timeout)
    stdout = proc.stdout.read()
    stderr = proc.stderr.read()
    rc = proc.wait()
    if check and rc != 0:
        raise RuntimeError(
            f"Sandbox command failed (rc={rc}): {' '.join(args)}\n"
            f"--- stdout ---\n{stdout[-4000:]}\n"
            f"--- stderr ---\n{stderr[-4000:]}"
        )
    return rc, stdout, stderr


def _write_sandbox_file(sb: modal.Sandbox, path: str, content: str, mode: int | None = None) -> None:
    proc = sb.exec(
        "python3",
        "-c",
        "import os, pathlib, sys; p = pathlib.Path(sys.argv[1]); "
        "p.parent.mkdir(parents=True, exist_ok=True); "
        "p.write_bytes(sys.stdin.buffer.read()); "
        "m = int(sys.argv[2], 8) if len(sys.argv) > 2 and sys.argv[2] else None; "
        "(os.chmod(p, m) if m is not None else None)",
        path,
        f"{mode:o}" if mode is not None else "",
    )
    proc.stdin.write(content.encode("utf-8"))
    proc.stdin.write_eof()
    proc.stdin.drain()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"Failed writing {path} in sandbox: {proc.stderr.read()}")


def _parse_muse_jsonl_output(stdout_text: str) -> tuple[dict[str, Any] | None, str]:
    final_text: str | None = None
    delta_chunks: list[str] = []

    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        payload_type = event.get("payload_type") or event.get("type") or ""
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else event

        if payload_type in {"run.terminal.completed", "run.completed"}:
            text = payload.get("text") or payload.get("output")
            if isinstance(text, str) and text.strip():
                final_text = text.strip()
        elif payload_type == "run.output.delta":
            text = payload.get("text")
            if isinstance(text, str):
                delta_chunks.append(text)

    candidate = final_text or "".join(delta_chunks).strip() or stdout_text.strip()
    if not candidate:
        return None, ""

    cleaned = candidate
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if len(lines) >= 3 and lines[-1].strip().startswith("```"):
            cleaned = "\n".join(lines[1:-1]).strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and (
            "verdict" in parsed or "session" in parsed or "checks_passed" in parsed
        ):
            return parsed, candidate
    except json.JSONDecodeError:
        pass

    return None, candidate


def _file_sha256_in_sandbox(sb: modal.Sandbox, path: str) -> str:
    _, out, _ = _exec(
        sb,
        "python3",
        "-c",
        "import hashlib, pathlib, sys; p = pathlib.Path(sys.argv[1]); "
        "print(hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else '')",
        path,
    )
    return out.strip()


def _run_muse_session(
    sb: modal.Sandbox,
    *,
    session_key: str,
    prompt_text: str,
    schema: dict[str, Any],
    read_only: bool,
    muse_model: str,
    reasoning_effort: str,
    max_steps: str,
) -> tuple[str, dict[str, Any] | None, str]:
    prompt_path = f"/tmp/prompt_{session_key}.txt"
    schema_path = f"/tmp/schema_{session_key}.json"
    cfg_dir = f"/tmp/muse-cfg-{session_key}"
    _write_sandbox_file(sb, prompt_path, prompt_text)
    _write_sandbox_file(sb, schema_path, json.dumps(schema, indent=2))

    # Give each concurrent session its own XDG_CONFIG_HOME to avoid .auth.json.lock contention.
    _exec(
        sb,
        "bash",
        "-lc",
        f"""
        set -euo pipefail
        mkdir -p {shlex.quote(cfg_dir)}/muse
        cp /root/.config/muse/settings.json {shlex.quote(cfg_dir)}/muse/settings.json
        if [ -f /root/.config/muse/auth.json ]; then
          cp /root/.config/muse/auth.json {shlex.quote(cfg_dir)}/muse/auth.json
          chmod 600 {shlex.quote(cfg_dir)}/muse/auth.json
        fi
        ln -sfn /root/.config/muse/skills {shlex.quote(cfg_dir)}/muse/skills
        """,
    )

    parts = [
        "muse",
        "exec",
        "--json",
        "--output-schema",
        schema_path,
        "--prompt-file",
        prompt_path,
        "--workspace",
        "/workspace/repo",
        "--session-id",
        str(uuid.uuid4()),
        "--yolo",
        "--disable-request-user-input",
        "--model",
        muse_model,
        "--reasoning-effort",
        reasoning_effort,
        "--max-model-steps",
        max_steps,
    ]
    if read_only:
        parts.append("--disable-write")

    cmd = " ".join(shlex.quote(p) for p in parts)
    rc, stdout, stderr = _exec(
        sb,
        "bash",
        "-lc",
        f"cd /workspace/repo && {cmd}",
        env={"XDG_CONFIG_HOME": cfg_dir},
        timeout=SESSION_EXEC_TIMEOUT_SECONDS,
        check=False,
    )
    parsed, fallback = _parse_muse_jsonl_output(stdout)
    if parsed is None:
        return session_key, None, (fallback or stderr or stdout)[-1500:] + f" (rc={rc})"
    return session_key, parsed, ""


@app.function(image=web_image)
@modal.fastapi_endpoint(method="GET")
def health() -> dict[str, str]:
    return {"status": "ok", "app": APP_NAME}


@app.function(
    image=web_image,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
@modal.fastapi_endpoint(method="POST")
async def github_webhook(request: Request) -> dict[str, Any]:
    raw_body = await request.body()
    webhook_secret = os.environ["GITHUB_WEBHOOK_SECRET"]
    sig_header = request.headers.get("X-Hub-Signature-256")

    if not verify_github_signature(raw_body, sig_header, webhook_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid X-Hub-Signature-256",
        )

    event_type = request.headers.get("X-GitHub-Event", "")
    if event_type == "ping":
        return {"status": "pong"}

    payload = json.loads(raw_body)
    review_drafts = os.environ.get("REVIEW_DRAFT_PRS", "").lower() in {"1", "true", "yes"}
    allow_forks = os.environ.get("ALLOW_FORK_PRS", "").lower() in {"1", "true", "yes"}

    trigger, reason = parse_webhook_event(
        event_type,
        payload,
        review_drafts=review_drafts,
        allow_forks=allow_forks,
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
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    timeout=FUNCTION_TIMEOUT_SECONDS,
)
def run_pr_review(
    repo: str,
    pr_number: int,
    trigger_source: str = "manual",
    custom_instructions: str = "",
) -> dict[str, Any]:
    github_token = os.environ["GITHUB_TOKEN"]
    meta_api_key = os.environ.get("META_API_KEY", "").strip()
    linear_api_key = os.environ.get("LINEAR_API_KEY", "").strip()
    muse_model = os.environ.get("MUSE_MODEL", "").strip() or DEFAULT_MUSE_MODEL
    reasoning_effort = (
        os.environ.get("MUSE_REASONING_EFFORT", "").strip() or DEFAULT_MUSE_REASONING_EFFORT
    )
    max_steps = (
        os.environ.get("MUSE_MAX_MODEL_STEPS", "").strip() or DEFAULT_MUSE_MAX_MODEL_STEPS
    )

    with httpx.Client(headers=github_headers(github_token), timeout=30.0) as gh:
        pr = fetch_pr_details(gh, repo, pr_number)
        pr_files = fetch_pr_files(gh, repo, pr_number)
        diff_line_map = build_diff_line_map(pr_files)

        head = pr["head"]
        base = pr["base"]
        head_sha = head["sha"]
        head_ref = head["ref"]
        base_ref = base["ref"]
        pr_title = pr.get("title") or ""
        pr_body = pr.get("body") or ""
        changed_files = [f["filename"] for f in pr_files if f.get("filename")]

        upsert_status_comment(
            gh,
            repo,
            pr_number,
            f"Muse Code (`{muse_model}`, effort `{reasoning_effort}`) is running 5 specialized review "
            f"sessions + hands-on app verification for `{head_sha[:7]}` (trigger: `{trigger_source}`)...",
        )

        sandbox_env: dict[str, str] = {
            "TBH_CREDENTIAL_BACKEND": "file",
            "XDG_CONFIG_HOME": "/root/.config",
            "HOME": "/root",
            "PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright",
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
        }
        if meta_api_key:
            sandbox_env["META_API_KEY"] = meta_api_key
        if linear_api_key:
            sandbox_env["LINEAR_API_KEY"] = linear_api_key

        muse_auth_vol.reload()

        sb = modal.Sandbox.create(
            "sleep",
            "infinity",
            app=app,
            image=sandbox_image,
            env=sandbox_env,
            volumes={"/mnt/muse-auth": muse_auth_vol},
            cpu=SANDBOX_CPU_CORES,
            memory=SANDBOX_MEMORY_MIB,
            timeout=SANDBOX_TIMEOUT_SECONDS,
        )

        try:
            _write_sandbox_file(sb, "/usr/local/bin/linear-read", LINEAR_READ_SCRIPT, mode=0o755)

            # Build clean Linux settings.json (no macOS MCPs) and wire read-only Linear MCP + pstack skills.
            linux_settings: dict[str, Any] = {
                "schema_version": 1,
                "provider": "meta",
                "model": muse_model,
                "reasoning_effort": reasoning_effort,
                "mcpServers": {},
            }
            if linear_api_key:
                linux_settings["mcpServers"]["linear"] = {
                    "type": "streamable-http",
                    "url": LINEAR_READONLY_MCP_URL,
                    "headers": {"Authorization": "Bearer ${LINEAR_API_KEY}"},
                }
            _write_sandbox_file(
                sb,
                "/root/.config/muse/settings.json",
                json.dumps(linux_settings, indent=2),
            )

            _exec(
                sb,
                "bash",
                "-lc",
                """
                set -euo pipefail
                mkdir -p /root/.config/muse
                if [ -f /mnt/muse-auth/auth.json ]; then
                  cp /mnt/muse-auth/auth.json /root/.config/muse/auth.json
                  chmod 600 /root/.config/muse/auth.json
                fi
                if [ -f /mnt/muse-auth/trust.json ]; then
                  cp /mnt/muse-auth/trust.json /root/.config/muse/trust.json
                fi
                ln -sfn /opt/muse-skills /root/.config/muse/skills
                """,
            )

            auth_before = _file_sha256_in_sandbox(sb, "/root/.config/muse/auth.json")
            if not auth_before and not meta_api_key:
                msg = (
                    "Muse Code is not authenticated in Modal yet. Run "
                    "`./infra/modal-pr-review/scripts/sync-muse-auth.sh` (or set `META_API_KEY` "
                    "in `praxis-pr-reviewer-secrets`) and re-trigger with `/muse`."
                )
                upsert_status_comment(gh, repo, pr_number, f"**Setup required:** {msg}")
                raise RuntimeError(msg)

            # Transient GIT_ASKPASS avoids persisting GITHUB_TOKEN into .git/config or muse exec env.
            clone_script = f"""
            set -euo pipefail
            mkdir -p /workspace
            ASKPASS=/tmp/git-askpass.sh
            cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$GITHUB_TOKEN" ;;
esac
EOF
            chmod 700 "$ASKPASS"
            GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git clone --depth=50 "https://github.com/{repo}.git" /workspace/repo
            cd /workspace/repo
            GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git fetch origin "{base_ref}" "{head_sha}"
            git checkout --detach "{head_sha}"
            rm -f "$ASKPASS"
            """
            _exec(sb, "bash", "-lc", clone_script, env={"GITHUB_TOKEN": github_token})

            _exec(
                sb,
                "bash",
                "-lc",
                """
                set -euo pipefail
                if [ -f /workspace/repo/cloud/package-lock.json ]; then
                  npm --prefix /workspace/repo/cloud ci --no-audit --no-fund
                fi
                """,
                timeout=600,
            )

            session_tasks: list[tuple[str, str, dict[str, Any], bool]] = []
            for profile in REVIEW_SESSION_PROFILES:
                session_tasks.append(
                    (
                        profile.key,
                        build_session_prompt(
                            profile,
                            repo=repo,
                            pr_number=pr_number,
                            title=pr_title,
                            body=pr_body,
                            base_ref=base_ref,
                            head_ref=head_ref,
                            head_sha=head_sha,
                            changed_files=changed_files,
                            custom_instructions=custom_instructions,
                        ),
                        REVIEW_SESSION_OUTPUT_SCHEMA,
                        profile.read_only,
                    )
                )
            session_tasks.append(
                (
                    "hands_on",
                    build_hands_on_prompt(
                        repo=repo,
                        pr_number=pr_number,
                        title=pr_title,
                        body=pr_body,
                        base_ref=base_ref,
                        head_ref=head_ref,
                        head_sha=head_sha,
                        changed_files=changed_files,
                        custom_instructions=custom_instructions,
                    ),
                    HANDS_ON_OUTPUT_SCHEMA,
                    False,
                )
            )

            session_results: list[dict[str, Any]] = []
            hands_on_result: dict[str, Any] | None = None
            session_errors: list[str] = []

            with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SESSIONS) as pool:
                futures = [
                    pool.submit(
                        _run_muse_session,
                        sb,
                        session_key=s_key,
                        prompt_text=s_prompt,
                        schema=s_schema,
                        read_only=s_ro,
                        muse_model=muse_model,
                        reasoning_effort=reasoning_effort,
                        max_steps=max_steps,
                    )
                    for s_key, s_prompt, s_schema, s_ro in session_tasks
                ]
                for fut in as_completed(futures):
                    s_key, parsed, err = fut.result()
                    if parsed is None:
                        session_errors.append(f"{s_key}: {err}")
                    elif s_key == "hands_on":
                        hands_on_result = parsed
                    else:
                        session_results.append(parsed)

            # Sync back any refreshed OAuth token from the newest session cfg.
            _exec(
                sb,
                "bash",
                "-lc",
                """
                newest=$(ls -t /tmp/muse-cfg-*/muse/auth.json 2>/dev/null | head -n1 || true)
                if [ -n "$newest" ]; then
                  cp "$newest" /root/.config/muse/auth.json
                fi
                """,
                check=False,
            )
            auth_after = _file_sha256_in_sandbox(sb, "/root/.config/muse/auth.json")
            if auth_after and auth_after != auth_before:
                _exec(
                    sb,
                    "bash",
                    "-lc",
                    "cp /root/.config/muse/auth.json /mnt/muse-auth/auth.json && sync /mnt/muse-auth",
                    check=False,
                )

            if not session_results and not hands_on_result:
                upsert_status_comment(
                    gh,
                    repo,
                    pr_number,
                    "All Muse Code sessions failed to return structured output:\n\n"
                    + "\n".join(f"- `{e}`" for e in session_errors),
                )
                return {
                    "status": "error",
                    "repo": repo,
                    "pr_number": pr_number,
                    "head_sha": head_sha,
                    "errors": session_errors,
                }

            merged_review = merge_session_reviews(
                session_results,
                hands_on_result,
                session_errors=session_errors,
            )
            submitted = submit_pr_review(
                gh,
                repo,
                pr_number,
                head_sha,
                merged_review,
                diff_line_map,
            )
            upsert_status_comment(
                gh,
                repo,
                pr_number,
                f"Muse Code (`{muse_model}`) posted multi-session review for `{head_sha[:7]}` "
                f"(verdict: `{merged_review.get('verdict')}`, "
                f"findings: `{len(merged_review.get('findings') or [])}`, "
                f"review id: `{submitted.get('id')}`).",
            )
            return {
                "status": "reviewed",
                "repo": repo,
                "pr_number": pr_number,
                "head_sha": head_sha,
                "verdict": merged_review.get("verdict"),
                "findings_count": len(merged_review.get("findings") or []),
                "sessions_completed": len(session_results) + (1 if hands_on_result else 0),
                "session_errors": session_errors,
                "review_id": submitted.get("id"),
            }
        finally:
            try:
                sb.terminate()
            except Exception:
                pass


@app.function(
    image=web_image,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    volumes={"/mnt/muse-auth": muse_auth_vol},
    timeout=300,
)
def check_sandbox_environment() -> dict[str, Any]:
    """Verify Sandbox.create, Node, Playwright Chromium, gh, muse, pstack skills, and Linear access."""
    muse_auth_vol.reload()
    auth_path = "/mnt/muse-auth/auth.json"
    has_auth_file = os.path.exists(auth_path)
    auth_info: dict[str, Any] = {"present": has_auth_file}
    if has_auth_file:
        data = json.loads(open(auth_path).read())
        meta = (data.get("providers") or {}).get("meta") or {}
        auth_info.update(
            {
                "mechanism": meta.get("mechanism"),
                "storage": meta.get("storage"),
                "has_access_token": bool(meta.get("access_token")),
                "user_email": meta.get("user_email"),
            }
        )

    linear_key = os.environ.get("LINEAR_API_KEY", "").strip()
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=sandbox_image,
        env={"LINEAR_API_KEY": linear_key} if linear_key else {},
        volumes={"/mnt/muse-auth": muse_auth_vol},
        timeout=180,
    )
    try:
        def srun(cmd: str) -> str:
            _, out, _ = _exec(sb, "bash", "-lc", cmd)
            return out.strip()

        _write_sandbox_file(sb, "/usr/local/bin/linear-read", LINEAR_READ_SCRIPT, mode=0o755)
        linear_status = (
            srun("linear-read list 1 | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d[\"data\"][\"issues\"][\"nodes\"]))'")
            if linear_key
            else "LINEAR_API_KEY missing"
        )

        return {
            "node": srun("node --version"),
            "npm": srun("npm --version"),
            "git": srun("git --version"),
            "gh": srun("gh --version | head -n1"),
            "muse": srun("muse --version"),
            "default_model": os.environ.get("MUSE_MODEL") or DEFAULT_MUSE_MODEL,
            "default_effort": os.environ.get("MUSE_REASONING_EFFORT") or DEFAULT_MUSE_REASONING_EFFORT,
            "installed_skills": srun("ls -1 /opt/muse-skills").splitlines(),
            "chromium_binary": srun(
                "find /opt/ms-playwright -name chrome -o -name headless_shell | head -n5"
            ),
            "linear_pra_probe_count": linear_status,
            "muse_auth_volume": auth_info,
        }
    finally:
        try:
            sb.terminate()
        except Exception:
            pass


@app.local_entrypoint()
def smoke_sandbox() -> None:
    """Run a quick health check inside the Modal sandbox image."""
    print(json.dumps(check_sandbox_environment.remote(), indent=2))


@app.local_entrypoint()
def review_pr(
    repo: str,
    pr: int,
    instructions: str = "",
) -> None:
    """Manually trigger a PR review in Modal for testing or re-runs."""
    result = run_pr_review.remote(
        repo=repo,
        pr_number=pr,
        trigger_source="manual_cli",
        custom_instructions=instructions,
    )
    print(json.dumps(result, indent=2))
