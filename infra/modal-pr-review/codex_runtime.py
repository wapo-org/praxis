"""Shared local and Modal Codex process contract; diagnostics never contain model payloads."""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
from typing import Any

from jsonschema import Draft202012Validator

CODEX_VERSION = "0.169.0"
MODEL = "gpt-6.2-sol"
REASONING_EFFORT = "low"
PROVIDER_URL = "https://api.codekey.ai"
SESSION_TIMEOUT_SECONDS = 900
SMOKE_TIMEOUT_SECONDS = 60
OUTPUT_MAX_BYTES = 8 * 1024 * 1024
SMOKE_SCHEMA = {"type": "object", "additionalProperties": False,
                "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
SMOKE_PROMPT = 'Return {"ok":true}. Do not use tools.'


class SessionFailure(RuntimeError):
    pass


def configuration(read_only: bool, linear: bool = False) -> str:
    text = f'''model = "{MODEL}"
model_provider = "codekey"
model_reasoning_effort = "{REASONING_EFFORT}"
approval_policy = "never"
sandbox_mode = "{'read-only' if read_only else 'workspace-write'}"
web_search = "disabled"
[model_providers.codekey]
name = "CodeKey"
base_url = "{PROVIDER_URL}"
env_key = "CODEKEY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 30000
[sandbox_workspace_write]
network_access = true
[shell_environment_policy]
inherit = "core"
exclude = ["*KEY*", "*TOKEN*", "*SECRET*", "*AUTH*"]
'''
    if linear:
        text += '''\n[mcp_servers.linear]
url = "https://mcp.linear.app/mcp/readonly"
bearer_token_env_var = "LINEAR_API_KEY"
startup_timeout_sec = 20
'''
    return text


def command(executable: str, schema_path: str, workspace: str, read_only: bool, images: list[str]) -> list[str]:
    args = [executable, "exec", "--ephemeral", "--json", "--skip-git-repo-check",
            "--color", "never", "--sandbox", "read-only" if read_only else "workspace-write",
            "--output-schema", schema_path, "--cd", workspace]
    for image in images:
        args.extend(("--image", image))
    return [*args, "-"]


def parse_output(stdout: str, rc: int, schema: dict[str, Any]) -> dict[str, Any]:
    if rc != 0:
        raise SessionFailure(f"codex_exit_{rc}")
    completed = False
    final = None
    try:
        for line in stdout.splitlines():
            event = json.loads(line)
            kind = event["type"]
            if completed:
                raise SessionFailure("events_after_completion")
            if kind in {"error", "turn.failed", "turn.aborted"}:
                raise SessionFailure("codex_terminal_failure")
            if kind == "item.completed":
                item = event["item"]
                if item.get("type") == "agent_message":
                    final = item["text"]
            if kind == "turn.completed":
                completed = True
        if not completed or not isinstance(final, str):
            raise SessionFailure("codex_incomplete")
        result = json.loads(final)
        Draft202012Validator.check_schema(schema)
        if not Draft202012Validator(schema).is_valid(result):
            raise SessionFailure("codex_schema_failure")
        return result
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SessionFailure("codex_malformed_output") from None


def run(
    prompt: str, schema: dict[str, Any], workspace: str, read_only: bool,
    executable: str = "codex", timeout: int = SESSION_TIMEOUT_SECONDS, images: list[str] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    if not os.environ.get("CODEKEY_API_KEY"):
        raise SessionFailure("codekey_credential_missing")
    if len(prompt.encode()) > OUTPUT_MAX_BYTES:
        raise SessionFailure("codex_prompt_limit")
    with tempfile.TemporaryDirectory(prefix=f"codex-{hashlib.sha256(str(Path(__file__).resolve()).encode()).hexdigest()[:12]}-") as home:
        os.chmod(home, 0o700)
        Path(home, "config.toml").write_text(configuration(read_only, bool(os.environ.get("LINEAR_API_KEY"))))
        schema_path = str(Path(home, "schema.json"))
        Path(schema_path).write_text(json.dumps(schema))
        env = {k: v for k, v in os.environ.items() if k in {
            "PATH", "HOME", "TMPDIR", "SYSTEMROOT", "CODEKEY_API_KEY", "LINEAR_API_KEY",
            "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"}}
        env["CODEX_HOME"] = home
        proc = subprocess.Popen(command(executable, schema_path, workspace, read_only, images or []),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, start_new_session=True)
        buffers: list[bytearray] = [bytearray(), bytearray()]
        overflow = threading.Event()

        def drain(stream, target):
            while chunk := stream.read(65536):
                if len(target) + len(chunk) > OUTPUT_MAX_BYTES:
                    overflow.set()
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    break
                target.extend(chunk)

        threads = [threading.Thread(target=drain, args=(stream, target))
                   for stream, target in zip((proc.stdout, proc.stderr), buffers)]
        def feed():
            try:
                proc.stdin.write(prompt.encode())
            except (BrokenPipeError, OSError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except BrokenPipeError:
                    pass

        threads.append(threading.Thread(target=feed))
        for thread in threads:
            thread.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise SessionFailure("codex_timeout") from None
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            for thread in threads:
                thread.join()
        if overflow.is_set():
            raise SessionFailure("codex_output_limit")
        for line in buffers[0].decode("utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
                item = event.get("item", {})
                if item.get("type") == "command_execution" and event.get("type") == "item.completed":
                    output = item.get("aggregated_output", "").lower()
                    print(json.dumps({"stage": "tool", "exit_code": item.get("exit_code"),
                                      "sandbox_error": any(word in output for word in
                                                           ("bwrap", "operation not permitted", "sandbox error"))}), flush=True)
            except (ValueError, AttributeError):
                pass
        result = parse_output(buffers[0].decode("utf-8", errors="strict"), proc.returncode, schema)
        print(json.dumps({"stage": "codex", "status": "validated", "terminal": "turn.completed",
                          "elapsed_seconds": round(time.monotonic() - started, 2)}), flush=True)
        return result


if __name__ == "__main__":
    import sys
    try:
        request = json.load(sys.stdin)
        result = run(**request)
        print(json.dumps({"result": result}))
    except Exception as exc:
        code = str(exc) if isinstance(exc, SessionFailure) else type(exc).__name__
        print(json.dumps({"stage": "codex", "status": "failed", "code": code}), flush=True)
        sys.exit(1)
