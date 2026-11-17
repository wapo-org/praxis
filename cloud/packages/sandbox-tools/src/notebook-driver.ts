import {EXPORT_FILE_MAX_BYTES, NOTEBOOK_ARTIFACTS_MAX, NOTEBOOK_INTERRUPT_SECONDS, NOTEBOOK_STARTUP_SECONDS, OUTPUT_MAX_BYTES} from './constants.js';

/** File mailboxes survive API workers; the daemon alone owns the kernel and its interrupt channel. */
export const NOTEBOOK_DRIVER = String.raw`
import base64
import fcntl
import json
from pathlib import Path
import queue
import subprocess
import sys
import time
import uuid

STATE = Path(sys.argv[2])
POLL_SECONDS = 0.05
STARTUP_SECONDS = ${NOTEBOOK_STARTUP_SECONDS}
INTERRUPT_SECONDS = ${NOTEBOOK_INTERRUPT_SECONDS}
TEXT_MAX_BYTES = ${OUTPUT_MAX_BYTES}
ARTIFACT_MAX_BYTES = ${EXPORT_FILE_MAX_BYTES}
ARTIFACTS_MAX = ${NOTEBOOK_ARTIFACTS_MAX}
LOST = "variables were lost"


def atomic(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(path)


def error(code, message):
    return dict(status=code, message=message)


class TextBuffer:
    def __init__(self):
        self.head = b""
        self.tail = b""
        self.total = 0

    def append(self, chunk):
        encoded = chunk.encode()
        self.total += len(encoded)
        half = TEXT_MAX_BYTES // 2
        take = min(half - len(self.head), len(encoded))
        self.head += encoded[:take]
        self.tail = (self.tail + encoded[take:])[-half:]

    def render(self):
        omitted = self.total - len(self.head) - len(self.tail)
        middle = ("\n… " + str(omitted) + " bytes omitted …\n") if omitted > 0 else ""
        return self.head.decode(errors="replace") + middle + self.tail.decode(errors="replace")


def run_cell(km, client, request, restarted):
    root = request["root"]
    # Changing directories is a separate silent cell so user code retains normal notebook syntax.
    setup = client.execute("import os as _praxis_os; _praxis_os.chdir(" + repr(root) + ")", silent=True)
    while client.get_shell_msg(timeout=STARTUP_SECONDS).get("parent_header", {}).get("msg_id") != setup:
        pass
    cell = client.execute(request["code"], allow_stdin=False, stop_on_error=True)
    deadline = time.monotonic() + request["timeout_ms"] / 1000
    interrupted = False
    output_budget = False
    text = TextBuffer()
    artifacts = []
    failed = False
    artifact_dir = Path(root) / ("notebook-" + request["id"])
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if interrupted:
                return error("upstream", "Kernel did not acknowledge interrupt; retry when the cell finishes.")
            km.interrupt_kernel()
            interrupted = True
            deadline = time.monotonic() + INTERRUPT_SECONDS
        try:
            message = client.get_iopub_msg(timeout=POLL_SECONDS)
        except queue.Empty:
            if not km.is_alive():
                return error("upstream", "Kernel exited; " + LOST)
            continue
        if message.get("parent_header", {}).get("msg_id") != cell:
            continue
        kind = message["header"]["msg_type"]
        content = message["content"]
        chunk = ""
        if kind == "stream":
            chunk = content["text"]
        elif kind == "error":
            failed = True
            chunk = "\n".join(content.get("traceback", []))
        elif kind in ("display_data", "execute_result", "update_display_data"):
            data = content.get("data", {})
            chunk = data.get("text/plain", "")
            for mime, extension in (("image/png", "png"), ("text/html", "html")):
                if mime not in data:
                    continue
                value = data[mime]
                if isinstance(value, list):
                    value = "".join(value)
                if output_budget:
                    continue
                payload = base64.b64decode(value) if mime == "image/png" else value.encode()
                if len(payload) > ARTIFACT_MAX_BYTES or len(artifacts) >= ARTIFACTS_MAX:
                    output_budget = True
                    if not interrupted:
                        km.interrupt_kernel()
                        interrupted = True
                        deadline = time.monotonic() + INTERRUPT_SECONDS
                    continue
                artifact_dir.mkdir(parents=True, exist_ok=True)
                path = artifact_dir / (str(len(artifacts)) + "." + extension)
                # Exclusive creation refuses existing symlinks planted by workspace code.
                with path.open("xb") as output:
                    output.write(payload)
                artifacts.append(str(path))
        if chunk:
            text.append(chunk)
        if kind == "status" and content.get("execution_state") == "idle":
            if output_budget:
                return error("budget", "Notebook rich output exceeded the artifact budget; reduce output.")
            if interrupted:
                return error("timeout", "Cell interrupted at its timeout; kernel and variables remain available.")
            if failed:
                return error("execution", text.render())
            return dict(status="ok", text=text.render(), truncated=text.total > TEXT_MAX_BYTES,
                        artifacts=artifacts, restarted=restarted,
                        message=LOST if restarted else "")


def daemon():
    from jupyter_client import KernelManager
    with (STATE / "daemon.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        km = None
        client = None
        restarted = (STATE / "started").exists()
        try:
            while True:
                inbox = STATE / "request.json"
                if not inbox.exists():
                    time.sleep(POLL_SECONDS)
                    continue
                request = json.loads(inbox.read_text())
                try:
                    if km is None or not km.is_alive():
                        restarted = restarted or km is not None
                        if client:
                            client.stop_channels()
                        km = KernelManager(kernel_name="python3")
                        km.start_kernel(cwd=request["root"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        client = km.blocking_client()
                        client.start_channels()
                        client.wait_for_ready(timeout=STARTUP_SECONDS)
                        (STATE / "started").touch()
                    result = run_cell(km, client, request, restarted)
                    if restarted and result["status"] != "ok":
                        result["message"] += "; " + LOST
                    restarted = False
                    if not km.is_alive():
                        restarted = True
                except Exception as exc:
                    result = error("upstream", "Notebook driver failed: " + str(exc))
                inbox.unlink()
                atomic(STATE / (request["id"] + ".json"), result)
        finally:
            if client:
                client.stop_channels()
            if km:
                km.shutdown_kernel(now=True)


def submit_request(request):
    with (STATE / "client.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return error("conflict", "Another notebook cell is running; retry when it finishes.")
        inbox = STATE / "request.json"
        with (STATE / "daemon.lock").open("w") as ownership:
            try:
                fcntl.flock(ownership, fcntl.LOCK_EX | fcntl.LOCK_NB)
                alive = False
            except BlockingIOError:
                alive = True
            if inbox.exists():
                if alive:
                    return error("conflict", "A notebook cell is still recovering; retry shortly.")
                inbox.unlink()
        if not alive:
            # The client lock excludes other submitters; release the ownership probe before the child acquires it.
            subprocess.Popen([sys.executable, __file__, "daemon", str(STATE)],
                             start_new_session=True, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        request["id"] = str(uuid.uuid4())
        response = STATE / (request["id"] + ".json")
        atomic(inbox, request)
        deadline = time.monotonic() + request["timeout_ms"] / 1000 + STARTUP_SECONDS + INTERRUPT_SECONDS
        while time.monotonic() < deadline:
            if response.exists():
                result = json.loads(response.read_text())
                response.unlink()
                return result
            time.sleep(POLL_SECONDS)
        return error("upstream", "Notebook driver unavailable; retry or recreate the sandbox.")


def submit():
    STATE.mkdir(parents=True, exist_ok=True)
    source = Path(sys.argv[3])
    try:
        request = json.loads(source.read_text())
        result = submit_request(request)
        print(json.dumps(result))
    finally:
        source.unlink(missing_ok=True)


if sys.argv[1] == "daemon":
    daemon()
else:
    submit()
`;
