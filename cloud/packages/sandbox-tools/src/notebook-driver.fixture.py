import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

DRIVER_PATH = Path(sys.argv.pop(1))
DRIVER = DRIVER_PATH.read_text()
MODULE = {"__file__": str(DRIVER_PATH)}
with patch.object(sys, "argv", ["driver.py", "submit", "/unused"]):
    exec(compile(DRIVER.rsplit('\nif sys.argv[1]', 1)[0], 'driver.py', 'exec'), MODULE)


class NotebookDriverTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        MODULE["STATE"] = self.state
        MODULE["STARTUP_SECONDS"] = 0.1
        MODULE["INTERRUPT_SECONDS"] = 0.1

    def request(self):
        return dict(root=str(self.state), code="value", timeout_ms=1, id="cell")

    def test_dead_daemon_mailbox_recovers(self):
        lock_path = self.state / "daemon.lock"
        holder = subprocess.Popen([sys.executable, "-c",
            "import fcntl,sys,time; f=open(sys.argv[1],'w'); "
            "fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(30)", str(lock_path)],
            stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.stdout.close)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "ready")
            (self.state / "request.json").write_text(json.dumps(self.request()))
            holder.kill()
            holder.wait(timeout=2)
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait(timeout=2)
        threads = []

        def launch(*args, **kwargs):
            self.assertFalse((self.state / "request.json").exists())

            def reply():
                inbox = self.state / "request.json"
                while not inbox.exists():
                    time.sleep(0.001)
                request = json.loads(inbox.read_text())
                inbox.unlink()
                MODULE["atomic"](self.state / (request["id"] + ".json"), dict(status="ok", restarted=True))
            thread = threading.Thread(target=reply)
            threads.append(thread)
            thread.start()
        with patch.object(subprocess, "Popen", side_effect=launch) as spawn:
            result = MODULE["submit_request"](self.request())
        for thread in threads:
            thread.join(timeout=2)
        self.assertEqual(result, dict(status="ok", restarted=True))
        spawn.assert_called_once()
        self.assertFalse((self.state / "request.json").exists())

    def test_child_acquires_daemon_lock_before_parent_resumes(self):
        module = self.state / "jupyter_client.py"
        module.write_text("""
import fcntl
from pathlib import Path
original_flock = fcntl.flock

def acknowledge_ownership(file, flags):
    original_flock(file, flags)
    Path(__file__).with_name('ownership-acquired').touch()

fcntl.flock = acknowledge_ownership

class KernelManager:
    def __init__(self, **kwargs): pass
    def start_kernel(self, **kwargs): pass
    def blocking_client(self): return self
    def start_channels(self): pass
    def wait_for_ready(self, **kwargs): pass
    def is_alive(self): return True
    def execute(self, *args, **kwargs): return 'cell'
    def get_shell_msg(self, **kwargs): return dict(parent_header=dict(msg_id='cell'))
    def get_iopub_msg(self, **kwargs):
        return dict(parent_header=dict(msg_id='cell'), header=dict(msg_type='status'), content=dict(execution_state='idle'))
""")
        processes = []
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            child = real_popen(*args, **kwargs, env={**os.environ, "PYTHONPATH": str(self.state)})
            processes.append(child)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                self.assertIsNone(child.poll(), "Daemon exited before parent completed Popen")
                if (self.state / "ownership-acquired").exists():
                    return child
                time.sleep(0.001)
            self.fail("Child did not acquire daemon ownership before parent resumed")
        try:
            with patch.object(subprocess, "Popen", side_effect=launch):
                result = MODULE["submit_request"]({**self.request(), "timeout_ms": 1000})
            self.assertEqual(result["status"], "ok", result)
            self.assertEqual(len(processes), 1)
            self.assertFalse((self.state / "request.json").exists())
        finally:
            for child in processes:
                child.kill()
                child.wait(timeout=2)

    def test_conflicting_calls_remove_private_request(self):
        for held in ("client.lock", "daemon.lock"):
            with self.subTest(held=held), (self.state / held).open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                (self.state / "request.json").write_text(json.dumps(self.request()))
                source = self.state / "private.request"
                source.write_text(json.dumps(self.request()))
                with patch.object(sys, "argv", ["driver.py", "submit", str(self.state), str(source)]), contextlib.redirect_stdout(None):
                    MODULE["submit"]()
                self.assertFalse(source.exists())
                self.assertTrue((self.state / "request.json").exists())
            (self.state / "request.json").unlink()

    def test_malformed_request_is_removed(self):
        source = self.state / "private.request"
        source.write_text("not json")
        with patch.object(sys, "argv", ["driver.py", "submit", str(self.state), str(source)]):
            with self.assertRaises(json.JSONDecodeError):
                MODULE["submit"]()
        self.assertFalse(source.exists())

    def test_text_buffer_is_bounded_and_keeps_head_and_tail(self):
        buffer = MODULE["TextBuffer"]()
        buffer.append("HEAD" + "x" * MODULE["TEXT_MAX_BYTES"])
        tracemalloc.start()
        for _ in range(100000):
            buffer.append("logs")
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        buffer.append("TRACEBACK")
        self.assertLess(peak, 100000)
        self.assertLessEqual(len(buffer.head) + len(buffer.tail), MODULE["TEXT_MAX_BYTES"])
        self.assertTrue(buffer.render().startswith("HEAD"))
        self.assertTrue(buffer.render().endswith("TRACEBACK"))
        self.assertIn("bytes omitted", buffer.render())
        small = MODULE["TextBuffer"]()
        small.append("small")
        self.assertEqual(small.render(), "small")

    def test_malformed_display_interrupts_loop_and_drains_before_next_cell(self):
        class Kernel:
            interrupted = False
            interrupts = 0

            def interrupt_kernel(self):
                self.interrupted = True
                self.interrupts += 1

            def is_alive(self):
                return True

        kernel = Kernel()
        owner = self

        class Client:
            first = True
            drained = False
            executions = 0

            def execute(self, code, **kwargs):
                if self.executions >= 2:
                    owner.assertTrue(self.drained, "Next cell started before the old execution drained")
                self.executions += 1
                return "cell"

            def get_shell_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id="cell"))

            def get_iopub_msg(self, **kwargs):
                if self.first:
                    self.first = False
                    return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="display_data"),
                                content=dict(data={"image/png": "a"}))
                # The cell loops forever after display unless the driver interrupts it.
                owner.assertTrue(kernel.interrupted, "Cell was left looping after malformed display")
                self.drained = True
                return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="status"),
                            content=dict(execution_state="idle"))
        client = Client()
        request = {**self.request(), "timeout_ms": 5000}
        result = MODULE["run_cell"](kernel, client, request, False)
        self.assertEqual(result["status"], "output-error")
        self.assertIn("interrupted and drained to idle", result["message"])
        self.assertTrue(client.drained)
        self.assertEqual(kernel.interrupts, 1)
        self.assertEqual(MODULE["run_cell"](kernel, client, request, False)["status"], "ok")

    def test_output_failure_with_ignored_interrupt_stops_busy_kernel(self):
        clock = [0]

        class Kernel:
            stopped = False

            def interrupt_kernel(self):
                clock[0] = 10

            def is_alive(self):
                return True

            def shutdown_kernel(self, **kwargs):
                self.stopped = True

        class Client:
            first = True

            def execute(self, *args, **kwargs):
                return "cell"

            def get_shell_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id="cell"))

            def get_iopub_msg(self, **kwargs):
                if self.first:
                    self.first = False
                    return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="display_data"),
                                content=dict(data={"image/png": "a"}))
                clock[0] = 20
                raise MODULE["queue"].Empty()
        kernel = Kernel()
        with patch.object(time, "monotonic", side_effect=lambda: clock[0]):
            result = MODULE["run_cell"](kernel, Client(), {**self.request(), "timeout_ms": 5000}, False)
        self.assertTrue(kernel.stopped)
        self.assertEqual(result["status"], "upstream")
        self.assertIn("variables were lost", result["message"])
        self.assertNotIn("drained to idle", result["message"])

    def test_oversized_artifacts_are_rejected_before_join_or_decode(self):
        for length in (60 * 1024 * 1024, 180 * 1024 * 1024):
            value = "A" * length
            for payload in (value, [value]):
                with self.subTest(length=length, fragmented=isinstance(payload, list)):
                    tracemalloc.start()
                    try:
                        with patch.object(MODULE["base64"], "b64decode") as decode:
                            with self.assertRaises(MODULE["ArtifactBudgetError"]):
                                MODULE["artifact_bytes"](payload, "image/png", 0)
                            decode.assert_not_called()
                        _, peak = tracemalloc.get_traced_memory()
                    finally:
                        tracemalloc.stop()
                    self.assertLess(peak, 100000)
        # Count rejection must precede even reading the next artifact value.
        with self.assertRaises(MODULE["ArtifactBudgetError"]):
            MODULE["artifact_bytes"](object(), "image/png", MODULE["ARTIFACTS_MAX"])
        self.assertEqual(MODULE["artifact_bytes"]("aGVsbG8=", "image/png", 0), b"hello")
        self.assertEqual(MODULE["artifact_bytes"](["<b>", "hi</b>"], "text/html", 0), b"<b>hi</b>")

    def test_verbose_cell_error_preserves_traceback(self):
        cell = "cell-id"
        messages = iter([
            dict(header=dict(msg_type="stream"), content=dict(text="HEAD" + "x" * 20000)),
            dict(header=dict(msg_type="error"), content=dict(traceback=["ValueError: untrusted content"])),
            dict(header=dict(msg_type="status"), content=dict(execution_state="idle")),
        ])

        class Client:
            def execute(self, code, **kwargs):
                return cell

            def get_shell_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id=cell))

            def get_iopub_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id=cell), **next(messages))
        result = MODULE["run_cell"](None, Client(), self.request(), False)
        self.assertEqual(result["status"], "execution")
        self.assertTrue(result["message"].startswith("HEAD"))
        self.assertTrue(result["message"].endswith("ValueError: untrusted content"))
        self.assertIn("bytes omitted", result["message"])


unittest.main()
