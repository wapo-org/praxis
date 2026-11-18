"""Adapt the deployed Codex process contract to the repository's review pipeline."""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import modal

from codex_runtime import SMOKE_PROMPT, SMOKE_SCHEMA, SMOKE_TIMEOUT_SECONDS
from muse_output import ERROR_TIMEOUT, ERROR_WRONG_SHAPE, MuseOutput
from pipeline import SessionRun
from sandbox import MAX_PARALLEL_SESSIONS, WORKSPACE, SessionTask, write_file

RUNNER = "/opt/praxis/codex_runtime.py"


def prepare_codex(sb: Any) -> None:
    write_file(sb, RUNNER, Path(__file__).with_name("codex_runtime.py").read_text(), mode=0o600)


def run_codex_session(
    sb: Any, task: SessionTask, *, credentials: dict[str, str], workspace: str = WORKSPACE,
) -> SessionRun:
    started = time.monotonic()
    payload = {
        "prompt": task.prompt, "schema": task.schema, "workspace": workspace,
        "read_only": task.read_only, "timeout": task.timeout_seconds, "images": list(task.images),
    }

    def result(output: MuseOutput, code: int | None) -> SessionRun:
        return SessionRun(task.session, output, output.final_text, code, time.monotonic() - started)

    try:
        proc = sb.exec("python3", RUNNER, timeout=task.timeout_seconds + 15,
                       secrets=[modal.Secret.from_dict(credentials)])
        with ThreadPoolExecutor(max_workers=2) as pool:
            stdout = pool.submit(proc.stdout.read)
            pool.submit(proc.stderr.read)
            proc.stdin.write(json.dumps(payload).encode())
            proc.stdin.write_eof()
            proc.stdin.drain()
            rc = proc.wait()
        lines = stdout.result().splitlines()
    except Exception:
        return result(MuseOutput(None, ERROR_TIMEOUT, ""), None)

    if rc != 0:
        return result(MuseOutput(None, "codex_process_failed", ""), rc)
    try:
        data = json.loads(lines[-1])["result"]
        if not isinstance(data, dict) or not all(key in data for key in task.required_keys):
            raise ValueError()
        if "session" in data and data["session"] != task.session:
            raise ValueError()
    except (ValueError, KeyError, IndexError, TypeError):
        return result(MuseOutput(None, ERROR_WRONG_SHAPE, ""), rc)
    return result(MuseOutput(data, None, json.dumps(data)), rc)


def run_codex_sessions(sb: Any, tasks: list[SessionTask], credentials: dict[str, str]) -> list[SessionRun]:
    prepare_codex(sb)
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SESSIONS) as pool:
        futures = [pool.submit(run_codex_session, sb, task, credentials=credentials) for task in tasks]
        return [future.result() for future in futures]


def smoke_task() -> SessionTask:
    return SessionTask(
        "smoke", SMOKE_PROMPT, SMOKE_SCHEMA, True, "1",
        required_keys=("ok",), timeout_seconds=SMOKE_TIMEOUT_SECONDS,
    )
