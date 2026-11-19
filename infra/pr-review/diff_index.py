"""Index of the new side of a PR diff: which lines exist and what they say."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

HUNK_HEADER_PATTERN = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
_WHITESPACE = re.compile(r"\s+")


def collapse(text: str) -> str:
    """Whitespace-insensitive form used for quote matching, so indentation never decides a verdict."""
    return _WHITESPACE.sub(" ", text).strip()


def parse_diff_right_text(patch: str | None) -> dict[int, str]:
    """Map new-side line number -> line text for every added or context line in a unified diff."""
    if not patch:
        return {}
    lines: dict[int, str] = {}
    right_line = 0
    in_hunk = False

    for raw_line in patch.splitlines():
        hunk_match = HUNK_HEADER_PATTERN.match(raw_line)
        if hunk_match:
            right_line = int(hunk_match.group(1))
            in_hunk = True
            continue
        if not in_hunk or raw_line.startswith("-") or raw_line.startswith("\\"):
            continue
        lines[right_line] = raw_line[1:]
        right_line += 1

    return lines


def parse_diff_right_lines(patch: str | None) -> set[int]:
    return set(parse_diff_right_text(patch))


@dataclass(frozen=True)
class DiffIndex:
    files: dict[str, dict[int, str]] = field(default_factory=dict)

    @classmethod
    def from_pr_files(cls, pr_files: list[dict[str, Any]]) -> DiffIndex:
        return cls(
            files={
                item["filename"]: parse_diff_right_text(item.get("patch"))
                for item in pr_files
                if item.get("filename")
            }
        )

    @classmethod
    def from_new_files(cls, contents: dict[str, str]) -> DiffIndex:
        """Diff where every file is brand new; used by the eval fixtures."""
        return cls(
            files={
                path: dict(enumerate(text.splitlines(), start=1))
                for path, text in contents.items()
            }
        )

    def has_file(self, path: str) -> bool:
        return bool(self.files.get(path))

    def has_line(self, path: str, line: int) -> bool:
        return line in self.files.get(path, {})

    def line_map(self) -> dict[str, set[int]]:
        return {path: set(lines) for path, lines in self.files.items()}

    def find_quote(self, path: str, quote: str) -> list[int]:
        """New-side line numbers where `quote` starts; multi-line quotes must sit on consecutive lines."""
        wanted = [collapse(part) for part in quote.splitlines() if collapse(part)]
        lines = self.files.get(path, {})
        if not wanted or not lines:
            return []

        starts: list[int] = []
        for number in sorted(lines):
            if self._matches_at(lines, number, wanted):
                starts.append(number)
        return starts

    @staticmethod
    def _matches_at(lines: dict[int, str], start: int, wanted: list[str]) -> bool:
        for offset, part in enumerate(wanted):
            text = lines.get(start + offset)
            if text is None or part not in collapse(text):
                return False
        return True
