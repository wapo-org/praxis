"""Closed list of rule ids a review finding may cite.

Source of truth is the prose: `[R…]` tags in AGENTS.md (mechanical rules) and the rule table in
REVIEW_GUIDELINES.md (judgement rules). `tests/test_rules.py` fails when this file and the docs drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Owner = Literal["script", "model"]


@dataclass(frozen=True)
class Rule:
    rule_id: str
    owner: Owner
    hard: bool
    needs_linear_quote: bool = False


def _script(rule_id: str) -> Rule:
    return Rule(rule_id=rule_id, owner="script", hard=True)


def _model(rule_id: str, *, hard: bool, needs_linear_quote: bool = False) -> Rule:
    return Rule(rule_id=rule_id, owner="model", hard=hard, needs_linear_quote=needs_linear_quote)


# Decided by cloud/scripts/check-rules.mjs or a gate command; model sessions may never cite these.
SCRIPT_RULES: tuple[Rule, ...] = (
    _script("R1.protocol-imports"),
    _script("R1.agent-imports"),
    _script("R1.web-imports"),
    _script("R1.web-effects"),
    _script("R1.api-imports-agent"),
    _script("R1.credentials-pool"),
    _script("R3.file-length"),
    _script("R4.no-any"),
    _script("R4.convex-v-any"),
    _script("R4.tenant-id-boundary"),
    _script("R5.banned-primitives"),
    _script("R5.client-owner-arg"),
    _script("R5.docs-commit"),
    _script("GATE.typecheck"),
    _script("GATE.test"),
    _script("GATE.check-rules"),
    _script("GATE.comment-sweep"),
)

# Judgement rules. `hard=True` means a verified, high-confidence finding may block the PR.
MODEL_RULES: tuple[Rule, ...] = (
    _model("R1.single-shape", hard=True),
    _model("R1.api-thin-routes", hard=True),
    _model("R1.client-policy-dup", hard=True),
    _model("R2.shared-constant", hard=False),
    _model("R2.unit-suffix", hard=False),
    _model("R3.readable-functions", hard=False),
    _model("R3.root-cause", hard=False),
    _model("R3.fail-closed", hard=True),
    _model("R4.boundary-parse", hard=True),
    _model("R4.illegal-states", hard=False),
    _model("R4.adhoc-brand", hard=False),
    _model("R5.owner-from-auth", hard=True),
    _model("R5.secret-leak", hard=True),
    _model("R5.ssrf-egress", hard=True),
    _model("R5.taint", hard=True),
    _model("G.clean-break", hard=False),
    _model("G.plan-docs", hard=False),
    _model("G.dead-code", hard=False),
    _model("G.duplicate-logic", hard=False),
    _model("G.unproven-claim", hard=False),
    _model("G.linear-contradiction", hard=False, needs_linear_quote=True),
    _model("CORRECTNESS", hard=False),
    _model("SECURITY", hard=False),
)

RULES: dict[str, Rule] = {rule.rule_id: rule for rule in (*SCRIPT_RULES, *MODEL_RULES)}

SCRIPT_RULE_IDS: frozenset[str] = frozenset(rule.rule_id for rule in SCRIPT_RULES)
MODEL_RULE_IDS: frozenset[str] = frozenset(rule.rule_id for rule in MODEL_RULES)

# One narrow job per session: a session may only cite its own ids.
SESSION_RULE_IDS: dict[str, tuple[str, ...]] = {
    "abstractions": (
        "R1.single-shape",
        "R1.api-thin-routes",
        "R1.client-policy-dup",
        "R2.shared-constant",
        "R2.unit-suffix",
        "R4.boundary-parse",
        "R4.illegal-states",
        "R4.adhoc-brand",
    ),
    "maintainability": (
        "G.clean-break",
        "G.plan-docs",
        "G.linear-contradiction",
        "R3.readable-functions",
    ),
    "conciseness": ("G.dead-code", "G.duplicate-logic"),
    "logic_bs": ("CORRECTNESS", "R3.root-cause", "G.unproven-claim"),
    "security": (
        "SECURITY",
        "R5.owner-from-auth",
        "R5.secret-leak",
        "R5.ssrf-egress",
        "R5.taint",
        "R3.fail-closed",
    ),
    "hands_on": ("CORRECTNESS",),
}


def is_hard(rule_id: str) -> bool:
    rule = RULES.get(rule_id)
    return bool(rule and rule.hard)
