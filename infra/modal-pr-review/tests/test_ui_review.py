from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import sandbox
from muse_output import MuseOutput
from pipeline import SessionRun
from ui_review import _run_on_preview, run_hosted_ui_review
from vercel_preview import PreviewConfig, PreviewUnavailable, preview_cookie, resolve_preview

SHA = "a" * 40
PROJECT = "prj_web"
URL = "https://praxis-pr-head.vercel.app"
FLOW = {"title": "Create a draft", "entry": "/", "steps": "Open and save the form", "expected": "Draft visible"}


def test_vercel_lookup_uses_ready_preview_for_exact_project_and_sha() -> None:
    ready = {
        "projectId": PROJECT, "meta": {"githubCommitSha": SHA}, "target": None,
        "readyState": "READY", "url": URL.removeprefix("https://"),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert dict(request.url.params) == {"projectId": PROJECT, "sha": SHA, "target": "preview", "teamId": "team_123"}
        assert request.headers["authorization"] == "Bearer api-secret"
        return httpx.Response(200, json={"deployments": [
            {**ready, "target": "production"},
            {**ready, "projectId": "prj_api"},
            {**ready, "meta": {"githubCommitSha": "b" * 40}},
            {**ready, "url": "evil.invalid/host.vercel.app"},
            {**ready, "readyState": "BUILDING"},
            ready,
        ]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert resolve_preview(client, PreviewConfig(PROJECT, "api-secret", "team_123"), SHA, wait_seconds=0) == URL


def test_vercel_cookie_bootstrap_does_not_follow_redirect_or_pass_long_lived_secret_to_browser() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == URL
        assert request.headers["x-vercel-protection-bypass"] == "project-secret"
        return httpx.Response(307, headers={
            "set-cookie": "_vercel_jwt=signed-session; Secure; HttpOnly; Path=/",
            "location": "https://elsewhere.invalid/",
        })

    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        cookie = preview_cookie(client, URL, "project-secret")
    assert cookie == {
        "name": "_vercel_jwt", "value": "signed-session", "url": URL,
        "secure": True, "httpOnly": True, "sameSite": "Lax",
    }


@pytest.mark.parametrize("status", [401, 403])
def test_protected_preview_without_access_is_reported(status: int) -> None:
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status))) as client:
        with pytest.raises(PreviewUnavailable, match="access was denied"):
            preview_cookie(client, URL, "")


def test_plan_skips_native_or_non_ui_changes_without_running_browser(tmp_path: Path) -> None:
    def unexpected() -> None:
        pytest.fail("should not create a browser sandbox")

    report, runs = run_hosted_ui_review(
        payload={"flows": []}, head_sha=SHA, config=PreviewConfig("", ""),
        create_sandbox=unexpected, configure_sandbox=lambda _: None, review_images=lambda *_: unexpected(),
        secret_env={}, destination=tmp_path,
    )
    assert report["status"] == "not_applicable"
    assert not runs


def test_recorded_browser_evidence_is_passed_to_configured_visual_reviewer(tmp_path: Path, monkeypatch) -> None:
    tools = Path(__file__).resolve().parents[1] / "browser"
    monkeypatch.setattr("ui_review.BROWSER_TOOLS", tools)
    monkeypatch.setattr(sandbox, "write_file", lambda *args, **kwargs: None)

    def exec_in(_, *args: str, **kwargs):
        if args[0] == "cat":
            return (0, '{"passed": true}', "") if "/flow-1/" in args[1] else (1, "", "")
        if args[0] == "python3":
            return 0, '["sheet-01.jpg"]', ""
        return 0, "", ""

    def copy(_, dst: Path) -> None:
        dst.write_bytes(b"recorded")

    def muse(_, task: sandbox.SessionTask, *, model: str, reasoning_effort: str, **kwargs) -> SessionRun:
        assert task.session == "ui_browser"
        assert model == "muse-ember-1.0"
        assert reasoning_effort == task.reasoning_effort == "medium"
        rows = [{"flow": n, "status": "passed", "observation": "Saved"} for n in (1, 2)]
        payload = {"results": rows}
        return SessionRun(task.session, MuseOutput(payload, None, ""), json.dumps(payload), 0, 1)

    def visual(manifest, files: tuple[Path, ...]) -> SessionRun:
        assert manifest[0]["images"] == [1]
        assert files == (tmp_path / "flow-1/sheet-01.jpg",)
        assert files[0].read_bytes() == b"recorded"
        rows = [{"flow": 1, "status": "issue", "observation": "Clipped in image 1"}]
        payload = {"results": rows}
        return SessionRun("ui_visual", MuseOutput(payload, None, ""), json.dumps(payload), 0, 1)

    monkeypatch.setattr(sandbox, "exec_in", exec_in)
    monkeypatch.setattr(sandbox, "run_muse_session", muse)
    sb = SimpleNamespace(filesystem=SimpleNamespace(copy_to_local=copy))
    report, runs = _run_on_preview(
        sb, url=URL, cookie=None, plan=[FLOW, FLOW], review_images=visual,
        secret_env={}, destination=tmp_path,
    )

    first, second = report["flows"]
    assert [run.session for run in runs] == ["ui_browser", "ui_visual"]
    assert first["browser"]["status"] == "passed"
    assert first["visual"]["status"] == "issue"
    assert (tmp_path / first["video"]).is_file()
    assert second["browser"]["status"] == second["visual"]["status"] == "inconclusive"
