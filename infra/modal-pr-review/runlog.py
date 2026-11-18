"""Persist every review run (never to GitHub) so slop can be measured instead of guessed."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from redact import redact_value
from validation import SessionValidation

RUN_RECORD_VERSION = 1
RUNS_VOLUME_NAME = "praxis-pr-review-runs"
RUNS_MOUNT_PATH = "/mnt/review-runs"
# Keeps one record small enough to read back in bulk; the tail of a transcript holds the final answer.
RAW_OUTPUT_MAX_CHARS = 200_000
_UNSAFE_PATH_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def session_record(
    *,
    session: str,
    raw_output: str,
    error: str | None,
    exit_code: int | None,
    duration_seconds: float,
    steps: int,
    usage: dict[str, int],
    event_counts: dict[str, int],
    validation: SessionValidation | None,
) -> dict[str, Any]:
    return {
        "session": session,
        "ok": error is None,
        "error": error,
        "exit_code": exit_code,
        "duration_seconds": round(duration_seconds, 2),
        "steps": steps,
        "usage": usage,
        "event_counts": event_counts,
        "raw_output": raw_output[-RAW_OUTPUT_MAX_CHARS:],
        "parsed_findings": validation.parsed if validation else [],
        "kept_findings": validation.kept if validation else [],
        "dropped_findings": validation.dropped if validation else [],
    }


def build_run_record(
    *,
    run_id: str,
    repo: str,
    pr_number: int,
    head_sha: str,
    trigger: str,
    model: str,
    reasoning_effort: str,
    token_kind: str,
    started_at: str,
    duration_seconds: float,
    status: str,
    error: str | None,
    verdict: str | None,
    review_id: int | None,
    gates: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    posted_findings: list[dict[str, Any]],
    secrets: Iterable[str] = (),
    ui_review: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record = {
        "version": RUN_RECORD_VERSION,
        "run_id": run_id,
        "repo": repo,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "trigger": trigger,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "github_token_kind": token_kind,
        "started_at": started_at,
        "duration_seconds": round(duration_seconds, 2),
        "status": status,
        "error": error,
        "verdict": verdict,
        "review_id": review_id,
        "gates": gates,
        "sessions": sessions,
        "posted_findings": posted_findings,
    }
    if ui_review is not None:
        record["ui_review"] = ui_review
    return redact_value(record, secrets)


def run_record_path(root: str | Path, record: dict[str, Any]) -> Path:
    repo = _UNSAFE_PATH_CHARS.sub("_", str(record["repo"]))
    stamp = _UNSAFE_PATH_CHARS.sub("", str(record["started_at"]).replace(":", ""))
    name = f"{stamp}-{str(record['head_sha'])[:7]}-{record['run_id']}.json"
    return Path(root) / repo / f"pr-{record['pr_number']}" / name


def write_run_record(root: str | Path, record: dict[str, Any]) -> Path:
    path = run_record_path(root, record)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
    return path


def load_run_records(root: str | Path, limit: int) -> list[dict[str, Any]]:
    """The newest `limit` records, newest first; unreadable or foreign-version files are skipped."""
    records: list[dict[str, Any]] = []
    base = Path(root)
    if not base.exists():
        return records
    for path in base.rglob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(record, dict) and record.get("version") == RUN_RECORD_VERSION:
            records.append(record)
    records.sort(key=lambda item: str(item.get("started_at")), reverse=True)
    return records[:limit]
