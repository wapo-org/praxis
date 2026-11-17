import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
from notebook_fixture_support import MODULE, NotebookDriverCase
from notebook_driver_output_cases import NotebookOutputTests
from notebook_driver_kernel_cases import NotebookKernelTests
from notebook_driver_recovery_cases import NotebookRecoveryTests


class NotebookMailboxTests(NotebookDriverCase):
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
    def get_shell_msg(self, **kwargs): return dict(parent_header=dict(msg_id='cell'), header=dict(msg_type='execute_reply'), content=dict(status='ok'))
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



unittest.main()
