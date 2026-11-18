"""Everything that runs inside the Modal Sandbox: checkout, deterministic gates and Muse sessions."""

from __future__ import annotations

import json
import shlex
import time
import uuid
from dataclasses import dataclass
from typing import Any

from gates import GateSpec, gate_result, gate_specs
from muse_output import ERROR_TIMEOUT, MuseOutput, parse_muse_output
from pipeline import SessionRun

WORKSPACE = "/workspace/repo"
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
    reasoning_effort: str | None = None
    images: tuple[str, ...] = ()
    timeout_seconds: int = SESSION_EXEC_TIMEOUT_SECONDS


def exec_in(
    sb: Any,
    *args: str,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = True,
) -> tuple[int, str, str]:
    proc = sb.exec(*args, env=env, timeout=timeout)
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


def write_file(sb: Any, path: str, content: str, mode: int | None = None) -> None:
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
    if proc.wait() != 0:
        raise RuntimeError(f"Failed writing {path} in sandbox")


def clone_repo(sb: Any, *, repo: str, refs: list[str], checkout: str, github_token: str) -> None:
    """Clone with a transient GIT_ASKPASS so the token never lands in .git/config or a later process env."""
    fetch_refs = " ".join(shlex.quote(ref) for ref in refs)
    script = f"""
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
    """Run CPU-heavy gates sequentially."""
    return [run_gate(sb, spec) for spec in gate_specs(diff_base)]


def configure_muse(
    sb: Any,
    *,
    model: str,
    reasoning_effort: str,
    auth_json: str | None,
    trust_json: str | None,
) -> None:
    """Install credentials and tools; call only after PR-controlled install and gate commands have finished."""
    settings: dict[str, Any] = {
        "schema_version": 1,
        "provider": "meta",
        "model": model,
        "reasoning_effort": reasoning_effort,
        "mcpServers": {},
    }
    write_file(sb, f"{MUSE_CONFIG_DIR}/settings.json", json.dumps(settings, indent=2))
    if auth_json:
        write_file(sb, f"{MUSE_CONFIG_DIR}/auth.json", auth_json, mode=0o600)
    if trust_json:
        write_file(sb, f"{MUSE_CONFIG_DIR}/trust.json", trust_json, mode=0o600)
    exec_in(sb, "bash", "-lc", f"ln -sfn /opt/muse-skills {MUSE_CONFIG_DIR}/skills")


def _session_config_dir(session: str) -> str:
    return f"/tmp/muse-cfg-{session}"


def run_muse_session(
    sb: Any,
    task: SessionTask,
    *,
    model: str,
    reasoning_effort: str,
    secret_env: dict[str, str],
    workspace: str = WORKSPACE,
) -> SessionRun:
    """One Muse session with its own config dir (auth lock contention) and secrets passed only to this process."""
    prompt_path = f"/tmp/prompt_{task.session}.txt"
    schema_path = f"/tmp/schema_{task.session}.json"
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
        workspace,
        "--session-id",
        str(uuid.uuid4()),
        "--yolo",
        "--disable-request-user-input",
        "--model",
        model,
        "--reasoning-effort",
        task.reasoning_effort or reasoning_effort,
        "--max-model-steps",
        task.max_steps,
    ]
    if task.read_only:
        parts.append("--disable-write")
    command = " ".join(shlex.quote(part) for part in parts)

    started = time.monotonic()
    try:
        rc, stdout, _ = exec_in(
            sb,
            "bash",
            "-lc",
            f"cd {shlex.quote(workspace)} && {command}",
            env={**secret_env, "XDG_CONFIG_HOME": cfg_dir},
            timeout=task.timeout_seconds,
            check=False,
        )
    except Exception:
        crashed = MuseOutput(payload=None, error=ERROR_TIMEOUT, final_text="")
        return SessionRun(task.session, crashed, "", None, time.monotonic() - started)

    output = parse_muse_output(stdout, task.required_keys)
    return SessionRun(task.session, output, stdout, rc, time.monotonic() - started)


def read_refreshed_auth(sb: Any) -> str | None:
    """The newest per-session auth.json, in case a session refreshed the OAuth token."""
    _, out, _ = exec_in(
        sb,
        "bash",
        "-lc",
        "newest=$(ls -t /tmp/muse-cfg-*/muse/auth.json 2>/dev/null | head -n1 || true); "
        'if [ -n "$newest" ]; then cat "$newest"; fi',
        check=False,
    )
    return out if out.strip() else None
