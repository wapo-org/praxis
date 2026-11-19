"""Keep development captures private and score only images collected from the review sandbox."""

from __future__ import annotations

import base64
import binascii
import os
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ARTIFACT_DIR = "/tmp/praxis-review-artifacts"
CONTACT_SHEET = "contact-sheet.png"
DEVELOPMENT_VIDEO = "development.webm"
VISUAL_SESSION = "visual_review"
CONTACT_SHEET_MAX_BYTES = 4 * 1024 * 1024
DEVELOPMENT_VIDEO_MAX_BYTES = 16 * 1024 * 1024
VISUAL_ISSUES_MAX = 3
VISUAL_ISSUE_MAX_CHARS = 200
VISUAL_VIEW_MAX_CHARS = 70
VISUAL_SCORE_MAX = 10
VISUAL_MODEL_STEPS_MAX = "4"
ARTIFACT_READ_TIMEOUT_SECONDS = 15
CONTACT_SHEET_MAX_PIXELS = 12_000_000
PNG_IHDR_BYTES = 24
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
WEBM_SIGNATURE = b"\x1a\x45\xdf\xa3"

ACCESS_REQUESTS = {
    "development_preview": "The development preview denied access. Grant the reviewer preview access privately, then rerun `/muse`.",
    "test_account": "The development flow requires a test account. Provision a scoped test account through the private reviewer configuration, then rerun `/muse`.",
    "development_configuration": "The development app is missing configuration needed to start. Configure the reviewer’s development environment privately, then rerun `/muse`.",
    "browser_runtime": "The browser runtime failed to start. Check the reviewer’s Playwright installation, then rerun `/muse`.",
}

# A rejected file stays in the container and never enters the reviewer process.
READ_ARTIFACT = '''
import base64
import os
import stat
import sys
from pathlib import Path

folder, name, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
path = Path(folder)
try:
    dfd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
                sys.exit(1)
            data = file.read(limit + 1)
            if len(data) != info.st_size:
                sys.exit(1)
            sys.stdout.write(base64.b64encode(data).decode("ascii"))
    finally:
        os.close(dfd)
except OSError:
    sys.exit(1)
'''


@dataclass(frozen=True)
class VisualAssessment:
    score: int
    inconsistencies: tuple[tuple[str, str], ...]
    recording_retained: bool


def visual_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["score", "inconsistencies"],
        "properties": {
            "score": {"type": "integer", "minimum": 0, "maximum": VISUAL_SCORE_MAX},
            "inconsistencies": {
                "type": "array",
                "maxItems": VISUAL_ISSUES_MAX,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["view", "issue"],
                    "properties": {
                        "view": {"type": "string", "maxLength": VISUAL_VIEW_MAX_CHARS},
                        "issue": {"type": "string", "maxLength": VISUAL_ISSUE_MAX_CHARS},
                    },
                },
            },
        },
    }


def parse_visual(payload: Any, *, recording_retained: bool) -> VisualAssessment | None:
    if not isinstance(payload, dict) or set(payload) != {"score", "inconsistencies"}:
        return None
    score, raw = payload["score"], payload["inconsistencies"]
    if type(score) is not int or not 0 <= score <= VISUAL_SCORE_MAX:
        return None
    if not isinstance(raw, list) or len(raw) > VISUAL_ISSUES_MAX:
        return None
    issues = []
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"view", "issue"}:
            return None
        view, issue = item["view"], item["issue"]
        if not isinstance(view, str) or not 0 < len(view.strip()) <= VISUAL_VIEW_MAX_CHARS:
            return None
        if not isinstance(issue, str) or not 0 < len(issue.strip()) <= VISUAL_ISSUE_MAX_CHARS:
            return None
        issues.append((public_text(view), public_text(issue)))
    return VisualAssessment(score, tuple(issues), recording_retained)


def public_text(value: str) -> str:
    value = " ".join(value.split())
    value = re.sub(r"(?i)(?:https?://|www\.)\S+", "[link omitted]", value)
    return value.translate(str.maketrans({"<": "‹", ">": "›", "@": "＠", "[": "［", "]": "］", "`": "'"}))


def access_request(hands_on: Any) -> str | None:
    blocker = hands_on.get("access_blocker") if isinstance(hands_on, dict) else None
    return ACCESS_REQUESTS.get(blocker) if isinstance(blocker, str) else None


def read_capture(sb: Any, name: str, limit: int, signature: bytes) -> bytes | None:
    proc = sb.exec("python3", "-c", READ_ARTIFACT, ARTIFACT_DIR, name, str(limit), timeout=ARTIFACT_READ_TIMEOUT_SECONDS)
    encoded = proc.stdout.read()
    if proc.wait() != 0 or len(encoded) > ((limit + 2) // 3) * 4:
        return None
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return None
    if not len(signature) < len(data) <= limit or not data.startswith(signature):
        return None
    if name == CONTACT_SHEET:
        if len(data) < PNG_IHDR_BYTES or data[12:16] != b"IHDR":
            return None
        width, height = struct.unpack(">II", data[16:24])
        if not 0 < width * height <= CONTACT_SHEET_MAX_PIXELS:
            return None
    return data


def retain_capture(destination: Path, name: str, payload: bytes) -> None:
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(destination / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(payload)


def artifact_notes(visual: VisualAssessment, *, run_id: str | None) -> list[str]:
    notes = []
    if run_id and visual.recording_retained:
        notes.append(f"Development video is available in the private reviewer artifacts for run `{run_id}`.")
    return notes
