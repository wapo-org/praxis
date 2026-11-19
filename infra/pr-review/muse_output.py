"""Parse `muse exec --json` output. A session either yields a JSON object or a fixed error class, never prose."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

ERROR_EMPTY = "empty_output"
ERROR_NOT_JSON = "malformed_json"
ERROR_WRONG_SHAPE = "wrong_shape"
ERROR_TIMEOUT = "timeout_or_crash"

COMPLETED_EVENTS = {"run.terminal.completed", "run.completed"}
DELTA_EVENT = "run.output.delta"
TOKEN_KEYS = ("input_tokens", "output_tokens", "total_tokens")


@dataclass
class MuseOutput:
    payload: dict[str, Any] | None
    error: str | None
    final_text: str
    event_counts: dict[str, int] = field(default_factory=dict)
    usage: dict[str, int] = field(default_factory=dict)

    @property
    def steps(self) -> int:
        """Best-effort step count: events whose type mentions a model or tool step."""
        return sum(
            count
            for name, count in self.event_counts.items()
            if "step" in name or "tool" in name
        )


def _strip_code_fence(text: str) -> str:
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if len(lines) >= 3 and lines[-1].strip().startswith("```"):
        return "\n".join(lines[1:-1]).strip()
    return text


def _add_usage(usage: dict[str, int], payload: dict[str, Any]) -> None:
    found = payload.get("usage")
    if not isinstance(found, dict):
        return
    for key in TOKEN_KEYS:
        value = found.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            usage[key] = usage.get(key, 0) + value


def parse_muse_output(stdout_text: str, required_keys: tuple[str, ...] = ("findings",)) -> MuseOutput:
    final_text: str | None = None
    delta_chunks: list[str] = []
    event_counts: dict[str, int] = {}
    usage: dict[str, int] = {}

    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue

        payload_type = str(event.get("payload_type") or event.get("type") or "")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
        if payload_type:
            event_counts[payload_type] = event_counts.get(payload_type, 0) + 1
        _add_usage(usage, payload)

        if payload_type in COMPLETED_EVENTS:
            text = payload.get("text") or payload.get("output")
            if isinstance(text, str) and text.strip():
                final_text = text.strip()
        elif payload_type == DELTA_EVENT:
            text = payload.get("text")
            if isinstance(text, str):
                delta_chunks.append(text)

    candidate = final_text or "".join(delta_chunks).strip()
    if not candidate and not event_counts:
        candidate = stdout_text.strip()
    result = MuseOutput(payload=None, error=None, final_text=candidate, event_counts=event_counts, usage=usage)

    if not candidate:
        result.error = ERROR_EMPTY
        return result
    try:
        parsed = json.loads(_strip_code_fence(candidate))
    except json.JSONDecodeError:
        result.error = ERROR_NOT_JSON
        return result
    if not isinstance(parsed, dict) or not all(key in parsed for key in required_keys):
        result.error = ERROR_WRONG_SHAPE
        return result

    result.payload = parsed
    return result
