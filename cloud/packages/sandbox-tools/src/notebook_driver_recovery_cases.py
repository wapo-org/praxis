import json
import sys
import time
import types
from unittest.mock import patch
from notebook_fixture_support import MODULE, NotebookDriverCase


class NotebookRecoveryTests(NotebookDriverCase):
    def test_ignored_sigint_and_transport_failures_restart_before_next_cell(self):
        for failure in ("ignored-sigint", "transport", "startup", "interrupt", "setup"):
            with self.subTest(failure=failure):
                clock = [0]
                kernels = []
                results = []
                state = self.state
                request = self.request()

                class StopDaemon(BaseException):
                    pass

                class Kernel:
                    stopped = False
                    channels_stopped = False
                    executions = 0
                    interrupts = 0

                    def __init__(self, **kwargs):
                        self.first = not kernels
                        kernels.append(self)

                    def start_kernel(self, **kwargs):
                        pass

                    def blocking_client(self):
                        return self

                    def start_channels(self):
                        pass

                    def stop_channels(self):
                        self.channels_stopped = True

                    def wait_for_ready(self, **kwargs):
                        if self.first and failure == "startup":
                            raise RuntimeError("Startup never became ready")

                    def is_alive(self):
                        return not self.stopped

                    def shutdown_kernel(self, **kwargs):
                        self.stopped = True

                    def interrupt_kernel(self):
                        self.interrupts += 1
                        if self.first and failure == "interrupt":
                            raise RuntimeError("Interrupt transport failed")

                    def execute(self, *args, **kwargs):
                        self.executions += 1
                        return "cell"

                    def get_shell_msg(self, **kwargs):
                        status = "unknown" if self.first and failure == "setup" else "ok"
                        return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="execute_reply"),
                                    content=dict(status=status))

                    def get_iopub_msg(self, **kwargs):
                        if self.first:
                            if failure == "transport":
                                raise RuntimeError("IOPub transport failed")
                            clock[0] += 1
                            raise MODULE["queue"].Empty()
                        return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="status"),
                                    content=dict(execution_state="idle"))

                atomic = MODULE["atomic"]

                def response(path, data):
                    atomic(path, data)
                    results.append(data)
                    if len(results) == 1:
                        (state / "request.json").write_text(json.dumps({**request, "id": "next"}))
                    else:
                        raise StopDaemon()

                (state / "started").unlink(missing_ok=True)
                (state / "request.json").write_text(json.dumps(request))
                with patch.dict(sys.modules, {"jupyter_client": types.SimpleNamespace(KernelManager=Kernel)}), \
                        patch.object(time, "monotonic", side_effect=lambda: clock[0]), \
                        patch.dict(MODULE, {"atomic": response}), self.assertRaises(StopDaemon):
                    MODULE["daemon"]()
                self.assertEqual(len(kernels), 2)
                self.assertTrue(kernels[0].stopped)
                self.assertTrue(kernels[0].channels_stopped)
                self.assertIn("variables were lost", results[0]["message"])
                if failure == "ignored-sigint":
                    self.assertEqual(kernels[0].interrupts, 1)
                    self.assertEqual(results[0]["status"], "timeout-reset")
                if failure == "setup":
                    self.assertEqual(kernels[0].executions, 1)
                self.assertEqual(results[1]["status"], "ok")
                self.assertTrue(results[1]["restarted"])
                self.assertIn("variables were lost", results[1]["message"])

    def test_acknowledged_timeout_preserves_the_kernel(self):
        clock = [0]

        class Kernel:
            interrupted = False

            def interrupt_kernel(self):
                self.interrupted = True

            def shutdown_kernel(self, **kwargs):
                raise AssertionError("A cooperative timeout must retain kernel variables")

            def is_alive(self):
                return True

        kernel = Kernel()

        class Client:
            def execute(self, *args, **kwargs):
                return "cell"

            def get_shell_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="execute_reply"),
                            content=dict(status="ok"))

            def get_iopub_msg(self, **kwargs):
                if not kernel.interrupted:
                    clock[0] += 1
                    raise MODULE["queue"].Empty()
                return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="status"),
                            content=dict(execution_state="idle"))

        with patch.object(time, "monotonic", side_effect=lambda: clock[0]):
            result = MODULE["run_cell"](kernel, Client(), self.request(), False)
        self.assertEqual(result["status"], "timeout")
        self.assertIn("variables remain available", result["message"])
