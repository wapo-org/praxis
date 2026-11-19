"""Sol code-review sessions: Codex CLI as the unprivileged `node` user, so the root-owned checkout stays read-only."""

from __future__ import annotations

import json
import shlex
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from muse_output import ERROR_TIMEOUT, MuseOutput, parse_muse_output
from pipeline import SessionRun
from sandbox import SESSION_EXEC_TIMEOUT_SECONDS, WORKSPACE, SessionTask, exec_in, write_file

CODEX_USER = "node"
CODEX_HOME_ROOT = "/home/node"
# Owned by `node` and made by the image, so prompts and outputs never sit in a shared /tmp.
CODEX_WORK_DIR = f"{CODEX_HOME_ROOT}/review"
DEFAULT_SOL_MODEL = "gpt-6.2-sol"
DEFAULT_SOL_REASONING_EFFORT = "low"
# Codex reads only these two files; sessions, logs and MCP servers from the operator's home never enter the sandbox.
CODEX_KEY_DIR = Path("/var/lib/praxis-review/codex-key")
CODEX_FILES = ("config.toml", "auth.json")
MAX_PARALLEL_CODE_SESSIONS = 5
TRANSCRIPT_TAIL_CHARS = 20000
# The bubblewrap sandbox cannot start under --cap-drop=all; the container plus the `node` user is the boundary.
CODEX_SANDBOX_FLAG = "--dangerously-bypass-approvals-and-sandbox"
# The image points XDG_CONFIG_HOME at /root/.config, which `node` cannot read. Set inside the container only:
# exec env values are also exported to the host podman process.
CODEX_USER_ENV = ("env", f"HOME={CODEX_HOME_ROOT}", f"XDG_CONFIG_HOME={CODEX_HOME_ROOT}/.config")


def read_codex_key(directory: Path = CODEX_KEY_DIR) -> dict[str, str] | None:
    files = {}
    for name in CODEX_FILES:
        path = directory / name
        if not path.is_file():
            return None
        files[name] = path.read_text(encoding="utf-8")
    return files


def _home(session: str) -> str:
    return f"{CODEX_HOME_ROOT}/.codex-{session}"


def configure_codex(sb: Any, codex_key: dict[str, str], sessions: list[str]) -> None:
    """Call only after PR-controlled install and gate commands have finished."""
    exec_in(sb, *CODEX_USER_ENV, "git", "config", "--global", "--add", "safe.directory", WORKSPACE, user=CODEX_USER)
    for session in sessions:
        home = _home(session)
        exec_in(sb, "mkdir", "-p", "-m", "700", home, user=CODEX_USER)
        for name, content in codex_key.items():
            write_file(sb, f"{home}/{name}", content, mode=0o600, user=CODEX_USER)


def run_codex_session(
    sb: Any,
    task: SessionTask,
    *,
    model: str,
    reasoning_effort: str,
    secret_env: dict[str, str],
) -> SessionRun:
    prompt_path = f"{CODEX_WORK_DIR}/prompt_{task.session}.txt"
    schema_path = f"{CODEX_WORK_DIR}/schema_{task.session}.json"
    output_path = f"{CODEX_WORK_DIR}/output_{task.session}.json"
    write_file(sb, prompt_path, task.prompt, user=CODEX_USER)
    write_file(sb, schema_path, json.dumps(task.schema), user=CODEX_USER)
    images = [arg for image in task.images for arg in ("-i", image)]
    # `-i` takes several values, so it must be followed by another flag rather than the `-` prompt argument.
    parts = [
        "codex", "exec", *images, "--skip-git-repo-check", "--ephemeral", CODEX_SANDBOX_FLAG,
        "-C", WORKSPACE, "-m", model, "-c", f"model_reasoning_effort={reasoning_effort}",
        "--output-schema", schema_path, "-o", output_path, "-",
    ]
    command = " ".join(shlex.quote(part) for part in parts)
    started = time.monotonic()
    try:
        rc, stdout, stderr = exec_in(
            sb, *CODEX_USER_ENV, "bash", "-lc",
            f"rm -f {output_path} && cd {WORKSPACE} && {command} < {prompt_path}",
            env={**secret_env, "CODEX_HOME": _home(task.session)},
            timeout=SESSION_EXEC_TIMEOUT_SECONDS, check=False, user=CODEX_USER,
        )
        _, final, _ = exec_in(sb, "cat", output_path, check=False, user=CODEX_USER)
    except Exception:
        crashed = MuseOutput(payload=None, error=ERROR_TIMEOUT, final_text="")
        return SessionRun(task.session, crashed, "", None, time.monotonic() - started)
    # A failed run must not reuse an answer file; the parser treats a bare JSON object as the final text.
    output = parse_muse_output(final if rc == 0 else "", task.required_keys)
    if rc != 0:
        output.error = ERROR_TIMEOUT
    # Codex logs its commands on stderr; the tail shows which files and diffs the reviewer actually read.
    return SessionRun(task.session, output, (stderr + stdout)[-TRANSCRIPT_TAIL_CHARS:], rc, time.monotonic() - started)


def run_codex_sessions(
    sb: Any,
    tasks: list[SessionTask],
    *,
    model: str,
    reasoning_effort: str,
    secret_env: dict[str, str],
) -> list[SessionRun]:
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_CODE_SESSIONS) as pool:
        futures = [
            pool.submit(run_codex_session, sb, task, model=model, reasoning_effort=reasoning_effort,
                        secret_env=secret_env)
            for task in tasks
        ]
        return [future.result() for future in futures]
