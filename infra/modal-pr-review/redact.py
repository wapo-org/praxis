"""Scrub secrets from any text before it is posted to GitHub or persisted."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

REDACTED = "[REDACTED]"
MIN_SECRET_LENGTH = 8

# Token shapes that must never leave the sandbox, even when we were not told the exact value.
TOKEN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}"),
)


def redact_text(text: str, secrets: Iterable[str] = ()) -> str:
    cleaned = text
    for secret in secrets:
        if secret and len(secret) >= MIN_SECRET_LENGTH:
            cleaned = cleaned.replace(secret, REDACTED)
    for pattern in TOKEN_PATTERNS:
        cleaned = pattern.sub(REDACTED, cleaned)
    return cleaned


def redact_value(value: Any, secrets: Iterable[str] = ()) -> Any:
    """Redact every string inside a JSON-like structure."""
    known = tuple(secrets)
    if isinstance(value, str):
        return redact_text(value, known)
    if isinstance(value, list):
        return [redact_value(item, known) for item in value]
    if isinstance(value, dict):
        return {key: redact_value(item, known) for key, item in value.items()}
    return value
