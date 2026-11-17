import contextlib
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

DRIVER = Path(sys.argv.pop(1)).read_text()
MODULE = {"__file__": "driver.py"}
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
