"""Run a planned UI review and preserve the evidence used by the visual reviewer."""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

import sandbox
from muse_output import MuseOutput
from pipeline import SessionRun
from redact import redact_text
from ui_prompts import EMBER, MAX_FLOWS, UI_OUTPUT, UI_WORKSPACE, browser_task
from vercel_preview import PreviewConfig, PreviewUnavailable, preview_cookie, resolve_preview

VisualReviewer = Callable[[list[dict[str, Any]], tuple[Path, ...]], SessionRun]

BROWSER_TOOLS = Path("/opt/pr-review-ui")
SETTINGS_PATH = "/tmp/ui-preview.json"
SHEET_FILENAME = re.compile(r"sheet-0[1-4]\.jpg")
FLOW_FIELDS = ("title", "entry", "steps", "expected")
BROWSER_STATUSES = {"passed", "failed", "blocked"}
VISUAL_STATUSES = {"looks_correct", "issue", "inconclusive"}


def _plan(payload: dict[str, Any] | None) -> list[dict[str, str]] | None:
    flows = payload.get("flows") if payload else None
    if not isinstance(flows, list) or len(flows) > MAX_FLOWS:
        return None
    plan = []
    for flow in flows:
        if not isinstance(flow, dict) or any(
            not isinstance(flow.get(key), str) or not flow[key].strip() or len(flow[key]) > 750
            for key in FLOW_FIELDS
        ):
            return None
        plan.append({key: flow[key].strip() for key in FLOW_FIELDS})
    return plan


def _results(run: SessionRun, statuses: set[str], allowed_flows: set[int]) -> dict[int, dict[str, str]]:
    rows = (run.output.payload or {}).get("results")
    if run.exit_code != 0 or not isinstance(rows, list) or len(rows) > MAX_FLOWS:
        return {}
    results = {}
    flow_numbers = Counter(
        row["flow"] for row in rows if isinstance(row, dict) and type(row.get("flow")) is int
    )
    for row in rows:
        if not isinstance(row, dict):
            continue
        flow = row.get("flow")
        status = row.get("status")
        observation = row.get("observation")
        if (
            type(flow) is int and flow in allowed_flows and flow_numbers[flow] == 1
            and isinstance(status, str) and status in statuses and isinstance(observation, str)
        ):
            results[flow] = {"status": status, "observation": observation.strip()[:750]}
    return results


def _capture(sb: Any, destination: Path, flow: int) -> tuple[list[str], bool]:
    directory = f"{UI_OUTPUT}/flow-{flow}"
    video = f"{directory}/workflow.webm"
    rc, marker, _ = sandbox.exec_in(sb, "cat", f"{directory}/result.json", timeout=15, check=False)
    if rc != 0:
        return [], False
    try:
        passed = json.loads(marker).get("passed") is True
    except (ValueError, AttributeError):
        return [], False
    rc, output, _ = sandbox.exec_in(
        sb, "python3", "/opt/pr-review-ui/contact-sheets.py", video, timeout=120, check=False
    )
    names = json.loads(output) if rc == 0 else []
    sheets = [f"{directory}/{name}" for name in names if SHEET_FILENAME.fullmatch(name)]
    destination.mkdir(parents=True, exist_ok=True)
    for source in [video, *sheets]:
        sb.filesystem.copy_to_local(source, destination / Path(source).name)

    try:
        mp4 = f"{directory}/workflow.mp4"
        rc, _, _ = sandbox.exec_in(
            sb, "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", video, "-an",
            "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "fast", "-crf", "24",
            "-maxrate", "550k", "-bufsize", "1100k", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            mp4, timeout=60, check=False,
        )
        if rc == 0:
            sb.filesystem.copy_to_local(mp4, destination / "workflow.mp4")
    except Exception:
        # Keep the original WebM available when MP4 conversion or transfer fails.
        pass
    return sheets, passed


def _run_on_preview(
    sb: Any,
    *,
    url: str,
    cookie: dict[str, Any] | None,
    plan: list[dict[str, str]],
    review_images: VisualReviewer,
    secret_env: dict[str, str],
    destination: Path,
) -> tuple[dict[str, Any], list[SessionRun]]:
    sandbox.exec_in(sb, "mkdir", "-p", UI_WORKSPACE)
    for filename in ("record.mjs", "contact-sheets.py"):
        path = BROWSER_TOOLS / filename
        sandbox.write_file(sb, str(path), path.read_text(encoding="utf-8"))
    sandbox.write_file(sb, SETTINGS_PATH, json.dumps({"baseURL": url, "cookie": cookie}), mode=0o600)
    try:
        browser = sandbox.run_muse_session(
            sb, browser_task(url, plan), model=EMBER, reasoning_effort="medium",
            secret_env=secret_env, workspace=UI_WORKSPACE,
        )
    finally:
        sandbox.exec_in(sb, "rm", "-f", SETTINGS_PATH)
    if cookie:
        browser.raw_output = redact_text(browser.raw_output, (cookie["value"],))

    numbers = set(range(1, len(plan) + 1))
    execution = _results(browser, BROWSER_STATUSES, numbers)
    report = {"status": "reviewed", "preview": url, "flows": []}
    manifest = []
    images: list[Path] = []
    for number, flow in enumerate(plan, start=1):
        folder = f"flow-{number}"
        try:
            sheets, script_passed = _capture(sb, destination / folder, number)
            video_saved = (destination / folder / "workflow.webm").is_file()
        except Exception:
            sheets, script_passed, video_saved = [], False, False
        result = execution.get(number, {"status": "inconclusive", "observation": "No usable browser result."})
        if result["status"] == "passed" and not (script_passed and sheets):
            result = {"status": "inconclusive", "observation": "No completed recording to substantiate the pass."}
        start = len(images) + 1
        if sheets:
            images.extend(destination / folder / Path(sheet).name for sheet in sheets)
            manifest.append({"flow": number, **flow, "images": list(range(start, len(images) + 1))})
        report["flows"].append({
            **flow,
            "browser": result,
            "video": f"{folder}/workflow.webm" if video_saved else None,
            "sheets": [f"{folder}/{Path(path).name}" for path in sheets],
            "visual": {"status": "inconclusive", "observation": "No visual assessment available."},
        })

    runs = [browser]
    if images:
        try:
            visual = review_images(manifest, tuple(images))
        except Exception:
            visual = SessionRun("ui_visual", MuseOutput(None, "visual_review_unavailable", ""), "", None, 0)
        if cookie:
            visual.raw_output = redact_text(visual.raw_output, (cookie["value"],))
        runs.append(visual)
        reviews = _results(visual, VISUAL_STATUSES, {item["flow"] for item in manifest})
        for number, result in reviews.items():
            report["flows"][number - 1]["visual"] = result

    if cookie:
        for flow in report["flows"]:
            for key in ("browser", "visual"):
                flow[key]["observation"] = redact_text(flow[key]["observation"], (cookie["value"],))
    return report, runs


def run_hosted_ui_review(
    *,
    payload: dict[str, Any] | None,
    head_sha: str,
    config: PreviewConfig,
    create_sandbox: Callable[[], Any],
    configure_sandbox: Callable[[Any], str | None],
    review_images: VisualReviewer,
    secret_env: dict[str, str],
    destination: Path,
    persist_auth: Callable[[Any, str | None], None] | None = None,
) -> tuple[dict[str, Any], list[SessionRun]]:
    plan = _plan(payload)
    if plan is None:
        return {"status": "blocked", "reason": "The reviewer did not produce a usable UI test plan."}, []
    if not plan:
        return {"status": "not_applicable", "reason": "The reviewer found no user-visible web change."}, []
    try:
        with httpx.Client(timeout=10.0, follow_redirects=False) as client:
            url = resolve_preview(client, config, head_sha)
            cookie = preview_cookie(client, url, config.bypass_secret)
    except PreviewUnavailable as exc:
        return {"status": "blocked", "reason": str(exc), "plan": plan}, []

    sb = None
    try:
        sb = create_sandbox()
        original = configure_sandbox(sb)
        report, runs = _run_on_preview(
            sb, url=url, cookie=cookie, plan=plan, review_images=review_images,
            secret_env=secret_env, destination=destination,
        )
        if persist_auth:
            try:
                persist_auth(sb, original)
            except Exception as exc:
                report["auth_refresh_error"] = type(exc).__name__
        return report, runs
    except Exception as exc:
        return {
            "status": "blocked",
            "reason": f"The browser review could not finish ({type(exc).__name__}).",
            "preview": url,
            "plan": plan,
        }, []
    finally:
        if sb is not None:
            sb.terminate()
