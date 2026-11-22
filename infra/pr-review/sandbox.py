"""Everything that runs inside the review container: checkout, deterministic gates and Muse sessions."""

from __future__ import annotations

import json
import shlex
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from gates import GateSpec, gate_result, gate_specs
from linear import LINEAR_READ_SCRIPT, LINEAR_READONLY_MCP_URL
from muse_output import ERROR_TIMEOUT, MuseOutput, parse_muse_output
from pipeline import SessionRun

WORKSPACE = "/workspace/repo"
# Root-only working folder made by the image; never a world-writable /tmp path.
REVIEW_DIR = "/root/review"
MUSE_CONFIG_DIR = "/root/.config/muse"
SESSION_EXEC_TIMEOUT_SECONDS = 900
DEPENDENCY_INSTALL_TIMEOUT_SECONDS = 600
MAX_PARALLEL_SESSIONS = 6
CLONE_DEPTH = 50
ERROR_TAIL_CHARS = 4000
# Sandbox processes killed by the exec timeout report a non-zero code; this margin tells the two apart.
TIMEOUT_MARGIN_SECONDS = 2


@dataclass(frozen=True)
class SessionTask:
    session: str
    prompt: str
    schema: dict[str, Any]
    read_only: bool
    max_steps: str
    required_keys: tuple[str, ...] = ("findings",)
    images: tuple[str, ...] = ()


def exec_in(
    sb: Any,
    *args: str,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = True,
    user: str | None = None,
) -> tuple[int, str, str]:
    proc = sb.exec(*args, env=env, timeout=timeout, **({"user": user} if user else {}))
    stdout = proc.stdout.read()
    stderr = proc.stderr.read()
    rc = proc.wait()
    if check and rc != 0:
        raise RuntimeError(
            f"Sandbox command failed (rc={rc})\n"
            f"--- stdout ---\n{stdout[-ERROR_TAIL_CHARS:]}\n"
            f"--- stderr ---\n{stderr[-ERROR_TAIL_CHARS:]}"
        )
    return rc, stdout, stderr


def write_file(sb: Any, path: str, content: str | bytes, mode: int | None = None, user: str | None = None) -> None:
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
        **({"user": user} if user else {}),
    )
    proc.stdin.write(content.encode("utf-8") if isinstance(content, str) else content)
    proc.stdin.write_eof()
    proc.stdin.drain()
    if proc.wait() != 0:
        raise RuntimeError(f"Failed writing {path} in sandbox")


def clone_repo(sb: Any, *, repo: str, refs: list[str], checkout: str, github_token: str) -> None:
    """Clone with a transient GIT_ASKPASS so the token never lands in .git/config or a later process env."""
    fetch_refs = " ".join(shlex.quote(ref) for ref in refs)
    script = f"""
set -euo pipefail
mkdir -p /workspace
ASKPASS={REVIEW_DIR}/git-askpass.sh
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$GITHUB_TOKEN" ;;
esac
EOF
chmod 700 "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0
git clone --depth={CLONE_DEPTH} {shlex.quote(f"https://github.com/{repo}.git")} {WORKSPACE}
cd {WORKSPACE}
if [ -n "{fetch_refs}" ]; then git fetch --depth={CLONE_DEPTH} origin {fetch_refs}; fi
git checkout --detach {shlex.quote(checkout)}
rm -f "$ASKPASS"
"""
    exec_in(sb, "bash", "-lc", script, env={"GITHUB_TOKEN": github_token})


def install_dependencies(sb: Any) -> None:
    """Runs PR-controlled install scripts, so it must happen before any credential enters the sandbox."""
    script = f"""
set -euo pipefail
if [ -f {WORKSPACE}/cloud/package-lock.json ]; then
  npm --prefix {WORKSPACE}/cloud ci --no-audit --no-fund
fi
"""
    exec_in(sb, "bash", "-lc", script, timeout=DEPENDENCY_INSTALL_TIMEOUT_SECONDS)


def run_gate(sb: Any, spec: GateSpec) -> dict[str, Any]:
    started = time.monotonic()
    try:
        rc, stdout, stderr = exec_in(
            sb,
            "bash",
            "-lc",
            f"cd {WORKSPACE} && {{ {spec.script.strip()}\n}} 2>&1",
            timeout=spec.timeout_seconds,
            check=False,
        )
    except Exception as exc:
        return gate_result(
            spec,
            exit_code=None,
            output="",
            duration_seconds=time.monotonic() - started,
            error=type(exc).__name__,
        )
    duration = time.monotonic() - started
    timed_out = rc != 0 and duration >= spec.timeout_seconds - TIMEOUT_MARGIN_SECONDS
    return gate_result(
        spec,
        exit_code=rc,
        output=stdout + stderr,
        duration_seconds=duration,
        error="timeout" if timed_out else None,
    )


def run_gates(sb: Any, diff_base: str) -> list[dict[str, Any]]:
    """Sequential on purpose: the gates are CPU-heavy and must not race the live app the hands-on session boots."""
    return [run_gate(sb, spec) for spec in gate_specs(diff_base)]


def configure_muse(
    sb: Any,
    *,
    model: str,
    reasoning_effort: str,
    auth_json: str | None,
    trust_json: str | None,
    with_linear: bool,
) -> None:
    """Install credentials and tools; call only after PR-controlled install and gate commands have finished."""
    settings: dict[str, Any] = {
        "schema_version": 1,
        "provider": "meta",
        "model": model,
        "reasoning_effort": reasoning_effort,
        "mcpServers": {},
    }
    if with_linear:
        settings["mcpServers"]["linear"] = {
            "type": "streamable-http",
            "url": LINEAR_READONLY_MCP_URL,
            "headers": {"Authorization": "Bearer ${LINEAR_API_KEY}"},
        }
    write_file(sb, f"{MUSE_CONFIG_DIR}/settings.json", json.dumps(settings, indent=2))
    write_file(sb, "/usr/local/bin/linear-read", LINEAR_READ_SCRIPT, mode=0o755)
    if auth_json:
        write_file(sb, f"{MUSE_CONFIG_DIR}/auth.json", auth_json, mode=0o600)
    if trust_json:
        write_file(sb, f"{MUSE_CONFIG_DIR}/trust.json", trust_json, mode=0o600)
    exec_in(sb, "bash", "-lc", f"ln -sfn /opt/muse-skills {MUSE_CONFIG_DIR}/skills")


def _session_config_dir(session: str) -> str:
    return f"{REVIEW_DIR}/muse-cfg-{session}"


def run_muse_session(
    sb: Any,
    task: SessionTask,
    *,
    model: str,
    reasoning_effort: str,
    secret_env: dict[str, str],
) -> SessionRun:
    """One Muse session with its own config dir (auth lock contention) and secrets passed only to this process."""
    prompt_path = f"{REVIEW_DIR}/prompt_{task.session}.txt"
    schema_path = f"{REVIEW_DIR}/schema_{task.session}.json"
    cfg_dir = _session_config_dir(task.session)
    write_file(sb, prompt_path, task.prompt)
    write_file(sb, schema_path, json.dumps(task.schema, indent=2))
    exec_in(
        sb,
        "bash",
        "-lc",
        f"""
set -euo pipefail
umask 077
mkdir -p {cfg_dir}/muse
cp {MUSE_CONFIG_DIR}/settings.json {cfg_dir}/muse/settings.json
if [ -f {MUSE_CONFIG_DIR}/auth.json ]; then cp {MUSE_CONFIG_DIR}/auth.json {cfg_dir}/muse/auth.json; fi
ln -sfn {MUSE_CONFIG_DIR}/skills {cfg_dir}/muse/skills
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
        WORKSPACE,
        "--disable-request-user-input",
        "--model",
        model,
        "--reasoning-effort",
        reasoning_effort,
        "--max-model-steps",
        task.max_steps,
    ]
    if not task.images:
        parts.extend(["--session-id", str(uuid.uuid4()), "--yolo"])
    if task.read_only:
        parts.append("--disable-write")
    if task.images:
        parts.extend(["--preset", "empty", "--disable-shell", "--disable-web-tools", "--disable-reminders",
                      "--no-foreign-personal-context", "--no-session-log"])
        for image in task.images:
            parts.extend(["--image", image])
    command = " ".join(shlex.quote(part) for part in parts)

    started = time.monotonic()
    try:
        # Set XDG_CONFIG_HOME inside the container only: Sandbox.exec also exports env to the host podman CLI.
        rc, stdout, stderr = exec_in(
            sb,
            "bash",
            "-lc",
            f"cd {WORKSPACE} && XDG_CONFIG_HOME={shlex.quote(cfg_dir)} {command}",
            env=secret_env,
            timeout=SESSION_EXEC_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception:
        crashed = MuseOutput(payload=None, error=ERROR_TIMEOUT, final_text="")
        return SessionRun(task.session, crashed, "", None, time.monotonic() - started)

    output = parse_muse_output(stdout, task.required_keys)
    raw = stdout if stdout.strip() else stderr
    return SessionRun(task.session, output, raw, rc, time.monotonic() - started)


def run_sessions(
    sb: Any,
    tasks: list[SessionTask],
    *,
    model: str,
    reasoning_effort: str,
    secret_env: dict[str, str],
) -> list[SessionRun]:
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SESSIONS) as pool:
        futures = [
            pool.submit(
                run_muse_session,
                sb,
                task,
                model=model,
                reasoning_effort=reasoning_effort,
                secret_env=secret_env,
            )
            for task in tasks
        ]
        return [future.result() for future in futures]


def read_refreshed_auth(sb: Any) -> str | None:
    """The newest per-session auth.json, in case a session refreshed the OAuth token."""
    _, out, _ = exec_in(
        sb,
        "bash",
        "-lc",
        f"newest=$(ls -t {REVIEW_DIR}/muse-cfg-*/muse/auth.json 2>/dev/null | head -n1 || true); "
        'if [ -n "$newest" ]; then cat "$newest"; fi',
        check=False,
    )
    return out if out.strip() else None
