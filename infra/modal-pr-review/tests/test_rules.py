from __future__ import annotations

import re
from pathlib import Path

from prompt_examples import SESSION_EXAMPLES
from prompts import REVIEW_SESSION_PROFILES
from rules import MODEL_RULE_IDS, MODEL_RULES, RULES, SCRIPT_RULE_IDS, SESSION_RULE_IDS

REVIEWER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = REVIEWER_DIR.parents[1]


def test_script_rules_match_agents_md_tags() -> None:
    agents = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    tagged = set(re.findall(r"\[(R\d\.[a-z0-9-]+)\]", agents))
    assert tagged == {rule_id for rule_id in SCRIPT_RULE_IDS if rule_id.startswith("R")}


def test_script_rules_match_check_rules_script() -> None:
    script = (REPO_ROOT / "cloud/scripts/check-rules-ast.mjs").read_text(encoding="utf-8")
    declared = set(re.findall(r"'(R\d\.[a-z0-9-]+)'", script))
    assert declared == {rule_id for rule_id in SCRIPT_RULE_IDS if rule_id.startswith("R")}


def test_model_rules_match_review_guidelines_table() -> None:
    guidelines = (REVIEWER_DIR / "REVIEW_GUIDELINES.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| `([A-Za-z0-9.-]+)` \| (HARD|advisory) \| ([a-z_, ]+) \|", guidelines, re.MULTILINE)
    assert {rule_id for rule_id, _, _ in rows} == MODEL_RULE_IDS
    for rule_id, kind, sessions in rows:
        assert RULES[rule_id].hard is (kind == "HARD"), rule_id
        owners = {name for name, ids in SESSION_RULE_IDS.items() if rule_id in ids}
        assert owners == {name.strip() for name in sessions.split(",")}, rule_id


def test_sessions_cite_only_model_rules_and_every_rule_has_an_owner() -> None:
    cited = {rule_id for ids in SESSION_RULE_IDS.values() for rule_id in ids}
    assert cited == MODEL_RULE_IDS
    assert not cited & SCRIPT_RULE_IDS
    assert {rule.rule_id for rule in MODEL_RULES if rule.needs_linear_quote} == {"G.linear-contradiction"}


def test_prompt_checklists_and_examples_use_the_session_rule_ids() -> None:
    for profile in REVIEW_SESSION_PROFILES:
        assert {rule_id for rule_id, _ in profile.checklist} == set(SESSION_RULE_IDS[profile.key])
        examples = SESSION_EXAMPLES[profile.key]
        assert 2 <= len(examples) <= 3
        assert any(not example.good for example in examples)
        for example in examples:
            if example.good:
                assert example.finding["rule_id"] in SESSION_RULE_IDS[profile.key]
