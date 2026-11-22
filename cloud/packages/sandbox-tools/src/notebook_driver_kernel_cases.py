import sys
import time
from unittest.mock import patch
from notebook_fixture_support import MODULE, NotebookDriverCase


class NotebookKernelTests(NotebookDriverCase):
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
                return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="execute_reply"), content=dict(status="ok"))

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
                return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="execute_reply"), content=dict(status="ok"))

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


    def test_failed_workspace_setup_never_dispatches_user_writes(self):
        expected = self.state / "expected"
        previous = self.state / "other-chat"
        previous.mkdir()
        owner = self
        for status in ("error", "aborted", "unknown", None):
            with self.subTest(status=status):
                class Kernel:
                    stopped = False

                    def interrupt_kernel(self):
                        pass

                    def shutdown_kernel(self, **kwargs):
                        self.stopped = True

                class Client:
                    calls = []

                    def execute(self, code, **kwargs):
                        self.calls.append(code)
                        if len(self.calls) > 1:
                            (previous / "unauthorized.txt").write_text("escaped")
                        return "setup"

                    def get_shell_msg(self, **kwargs):
                        return dict(parent_header=dict(msg_id="setup"), header=dict(msg_type="execute_reply"),
                                    content=dict(status=status))

                    def get_iopub_msg(self, **kwargs):
                        owner.fail("User execution must not start after setup failure")
                client = Client()
                kernel = Kernel()
                result = MODULE["run_cell"](kernel, client, {
                    **self.request(), "root": str(expected), "code": "open('unauthorized.txt', 'w').write('escaped')",
                }, False)
                self.assertEqual(result["status"], "setup-error")
                self.assertEqual(len(client.calls), 1)
                self.assertIn("_praxis_os.getcwd() != " + repr(str(expected)), client.calls[0])
                self.assertFalse((previous / "unauthorized.txt").exists())
                self.assertFalse(expected.exists())
                self.assertEqual(kernel.stopped, status not in ("error", "aborted"))
                if kernel.stopped:
                    self.assertIn("variables were lost", result["message"])


    def test_setup_verification_rejects_a_different_canonical_directory(self):
        import types
        previous = self.state / "other-chat"
        previous.mkdir()
        expected = self.state / "expected"
        expected.mkdir()
        os_module = types.SimpleNamespace(chdir=lambda path: None, getcwd=lambda: str(previous))
        with patch.dict(sys.modules, {"os": os_module}):
            class Client:
                calls = 0
                status = "ok"

                def execute(self, code, **kwargs):
                    self.calls += 1
                    try:
                        exec(code, {})
                    except RuntimeError:
                        self.status = "error"
                    return "setup"

                def get_shell_msg(self, **kwargs):
                    return dict(parent_header=dict(msg_id="setup"), header=dict(msg_type="execute_reply"),
                                content=dict(status=self.status))
            client = Client()
            result = MODULE["run_cell"](None, client, {**self.request(), "root": str(expected)}, False)
        self.assertEqual(result["status"], "setup-error")
        self.assertEqual(client.calls, 1)


    def test_execution_reply_status_is_required_for_success(self):
        for status in ("error", "aborted", "unknown", None):
            with self.subTest(status=status):
                class Client:
                    executions = 0

                    def execute(self, code, **kwargs):
                        self.executions += 1
                        return "cell"

                    def get_shell_msg(self, **kwargs):
                        return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="execute_reply"),
                                    content=dict(status="ok" if self.executions == 1 else status))

                    def get_iopub_msg(self, **kwargs):
                        return dict(parent_header=dict(msg_id="cell"), header=dict(msg_type="status"),
                                    content=dict(execution_state="idle"))
                result = MODULE["run_cell"](None, Client(), {**self.request(), "timeout_ms": 5000}, False)
                self.assertNotEqual(result["status"], "ok")


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
                return dict(parent_header=dict(msg_id=cell), header=dict(msg_type="execute_reply"), content=dict(status="ok"))

            def get_iopub_msg(self, **kwargs):
                return dict(parent_header=dict(msg_id=cell), **next(messages))
        result = MODULE["run_cell"](None, Client(), self.request(), False)
        self.assertEqual(result["status"], "execution")
        self.assertTrue(result["message"].startswith("HEAD"))
        self.assertTrue(result["message"].endswith("ValueError: untrusted content"))
        self.assertIn("bytes omitted", result["message"])


