"""Deterministic gates: the server runs these commands itself, so no model ever judges their outcome."""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from typing import Any

from rules import SCRIPT_RULE_IDS

GATE_OUTPUT_TAIL_CHARS = 3000
GATE_FINDINGS_MAX = 50
SKIP_MARKER = "GATE-SKIPPED:"
CLOUD_PREFIX = "cloud/"

STATUS_PASSED = "passed"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"
STATUS_ERROR = "error"

CHECK_RULES_LINE = re.compile(r"^(?P<path>[^\s:]+):(?P<line>\d+) (?P<rule>[A-Z0-9]+\.[a-z0-9-]+) (?P<message>.+)$")


@dataclass(frozen=True)
class GateSpec:
    key: str
    rule_id: str
    timeout_seconds: int
    script: str


def _check_rules_script(diff_base: str) -> str:
    """Compare against the merge-base baseline so a PR cannot pass by growing its own baseline."""
    base = shlex.quote(diff_base)
    return f"""
if [ ! -f cloud/scripts/check-rules.mjs ]; then
  echo "{SKIP_MARKER} cloud/scripts/check-rules.mjs does not exist at this commit"
  exit 0
fi
merge_base=$(git merge-base {base} HEAD 2>/dev/null || echo {base})
if git show "$merge_base:cloud/scripts/check-rules.baseline.json" > /tmp/check-rules.base.json 2>/dev/null; then
  node cloud/scripts/check-rules.mjs --baseline /tmp/check-rules.base.json
else
  node cloud/scripts/check-rules.mjs
fi
"""


def gate_specs(diff_base: str) -> tuple[GateSpec, ...]:
    return (
        GateSpec("typecheck", "GATE.typecheck", 300, "npm --prefix cloud run typecheck"),
        GateSpec("test", "GATE.test", 480, "npm --prefix cloud test -- --reporter=dot"),
        GateSpec("check-rules", "GATE.check-rules", 120, _check_rules_script(diff_base)),
        GateSpec("comment-sweep", "GATE.comment-sweep", 120, "node cloud/scripts/comment-sweep.mjs check"),
    )


def parse_check_rules_output(output: str) -> list[dict[str, Any]]:
    """Turn `path:line rule-id message` lines into findings, repo-relative, verbatim message."""
    findings: list[dict[str, Any]] = []
    for raw_line in output.splitlines():
        match = CHECK_RULES_LINE.match(raw_line.strip())
        if not match or match.group("rule") not in SCRIPT_RULE_IDS:
            continue
        findings.append(
            {
                "rule_id": match.group("rule"),
                "file": CLOUD_PREFIX + match.group("path"),
                "line": int(match.group("line")),
                "message": match.group("message"),
            }
        )
    return findings[:GATE_FINDINGS_MAX]


def gate_result(
    spec: GateSpec,
    *,
    exit_code: int | None,
    output: str,
    duration_seconds: float,
    error: str | None = None,
) -> dict[str, Any]:
    """`error` means the gate itself broke (timeout, sandbox fault); only `failed` blocks a PR."""
    if error is not None or exit_code is None:
        status = STATUS_ERROR
    elif exit_code == 0:
        status = STATUS_SKIPPED if SKIP_MARKER in output else STATUS_PASSED
    else:
        status = STATUS_FAILED

    findings: list[dict[str, Any]] = []
    if spec.key == "check-rules" and status == STATUS_FAILED:
        findings = parse_check_rules_output(output)

    return {
        "key": spec.key,
        "rule_id": spec.rule_id,
        "status": status,
        "exit_code": exit_code,
        "duration_seconds": round(duration_seconds, 2),
        "error": error,
        "output_tail": output[-GATE_OUTPUT_TAIL_CHARS:],
        "findings": findings,
    }


def any_gate_failed(gates: list[dict[str, Any]]) -> bool:
    return any(gate.get("status") == STATUS_FAILED for gate in gates)
