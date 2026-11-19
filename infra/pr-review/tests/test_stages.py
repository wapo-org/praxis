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
