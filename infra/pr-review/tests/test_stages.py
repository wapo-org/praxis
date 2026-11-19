from muse_output import MuseOutput
from pipeline import SessionRun
from preview import PreviewUnavailable, preview_target
from stages import blocked_hands_on, ui_requests
from visual_review import access_request


def run(session: str, payload: dict | None) -> SessionRun:
    return SessionRun(session, MuseOutput(payload=payload, error=None, final_text=""), "", 0, 1.0)


def test_only_non_empty_ui_check_requests_reach_the_hands_on_stage() -> None:
    sessions = [
        run("abstractions", {"findings": [], "ui_check": None}),
        run("logic_bs", {"findings": [], "ui_check": "  Open   settings\nand save a model.  "}),
        run("security", {"findings": [], "ui_check": "   "}),
        run("conciseness", None),
    ]
    assert ui_requests(sessions) == [("logic_bs", "Open settings and save a model.")]


def test_missing_test_account_becomes_a_private_access_request() -> None:
    config = {"VERCEL_TOKEN": "t", "VERCEL_WEB_PROJECT_ID": "prj_1"}
    try:
        preview_target(config, "a" * 40, 1)
    except PreviewUnavailable as error:
        hands_on = blocked_hands_on(error.blocker, str(error))
    else:
        raise AssertionError("an incomplete config must not resolve a preview")
    payload = hands_on.output.payload
    assert payload["ran"] is False and payload["access_blocker"] == "test_account"
    assert "PREVIEW_TEST_PASSWORD" in payload["manual_observations"]
    assert access_request(payload) is not None


class _Stream:
    def __init__(self, text: str = ""):
        self.text = text

    def read(self) -> str:
        return self.text

    def write(self, _data: bytes) -> None:
        return None

    def write_eof(self) -> None:
        return None

    def drain(self) -> None:
        return None


class _Process:
    def __init__(self, rc: int, stdout: str = ""):
        self.rc, self.stdin, self.stdout, self.stderr = rc, _Stream(), _Stream(stdout), _Stream()

    def wait(self) -> int:
        return self.rc


class _CrashingCodex:
    """Codex exits 1, while an answer file from an earlier attempt is still readable."""

    def exec(self, *args, env=None, timeout=None, user=None):
        if args[0] == "cat":
            return _Process(0, '{"session": "logic_bs", "findings": [], "ui_check": "stale"}')
        return _Process(1 if "codex" in " ".join(args) else 0)


def test_a_failed_codex_run_never_reuses_an_answer_file() -> None:
    from codex_session import run_codex_session
    from sandbox import SessionTask

    task = SessionTask(session="logic_bs", prompt="p", schema={}, read_only=True, max_steps="40")
    run = run_codex_session(_CrashingCodex(), task, model="m", reasoning_effort="low", secret_env={})
    assert run.output.payload is None and run.output.error is not None
