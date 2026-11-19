from unittest.mock import Mock

import stages
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
    def __init__(self, rc: int, stdout: str = "", stderr: str = ""):
        self.rc, self.stdin, self.stdout, self.stderr = rc, _Stream(), _Stream(stdout), _Stream(stderr)

    def wait(self) -> int:
        return self.rc


class _RecordingMuseSandbox:
    def __init__(self) -> None:
        self.muse_calls: list[tuple[tuple[str, ...], dict[str, str] | None]] = []

    def exec(self, *args, env=None, timeout=None, user=None):
        if any("muse exec" in str(a) for a in args):
            self.muse_calls.append((args, env))
            return _Process(1, stdout="", stderr="muse stderr failure")
        return _Process(0)


def test_run_muse_session_keeps_xdg_inside_container_and_retains_stderr() -> None:
    from sandbox import SessionTask, run_muse_session

    sb = _RecordingMuseSandbox()
    task = SessionTask(session="hands_on", prompt="p", schema={}, read_only=False, max_steps="80")
    result = run_muse_session(sb, task, model="muse-ember-1.0", reasoning_effort="medium", secret_env={"META_API_KEY": "k"})
    assert len(sb.muse_calls) == 1
    args, env = sb.muse_calls[0]
    assert env == {"META_API_KEY": "k"}
    assert "XDG_CONFIG_HOME=/root/review/muse-cfg-hands_on" in " ".join(args)
    assert result.raw_output == "muse stderr failure"


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


def test_visual_assessment_writes_the_validated_sheet_as_node(monkeypatch) -> None:
    sheet = b"\x89PNG\r\n\x1a\n"
    sb = Mock()
    sb.exec.return_value.wait.return_value = 0
    score = run("visual_review", {"score": 8, "inconsistencies": []})
    model = Mock(return_value=score)
    monkeypatch.setattr(stages, "run_codex_session", model)

    assessment = stages.assess_with_sol(sb, [], sheet=sheet, model="sol", effort="low", recording_retained=True)

    assert assessment is not None and assessment.score == 8
    args, kwargs = sb.exec.call_args
    assert args[0] == "python3" and args[-2:] == (stages.VISION_COPY, "600")
    assert kwargs == {"user": "node"}
    sb.exec.return_value.stdin.write.assert_called_once_with(sheet)
    assert model.call_args.args[1].images == (stages.VISION_COPY,)
