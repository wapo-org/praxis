from __future__ import annotations

import json

from evals.harness import (
    CASES_DIR,
    RECORDED_DIR,
    format_scores,
    load_cases,
    predictions_from_run,
    run_offline,
    score,
    score_cases,
)
from rules import RULES


def test_score_counts_precision_and_recall_per_rule() -> None:
    expected = [frozenset({("A", "f.ts"), ("B", "f.ts")}), frozenset(), frozenset({("A", "g.ts")})]
    predicted = [{("A", "f.ts"), ("C", "f.ts")}, {("C", "x.ts")}, set()]
    result = score(expected, predicted)
    assert (result["tp"], result["fp"], result["fn"]) == (1, 2, 2)
    assert result["precision"] == 0.333 and result["recall"] == 0.333
    assert result["by_rule"] == {
        "A": {"tp": 1, "fp": 0, "fn": 1},
        "B": {"tp": 0, "fp": 0, "fn": 1},
        "C": {"tp": 0, "fp": 2, "fn": 0},
    }
    silent = score([frozenset()], [set()])
    assert silent["precision"] == 1.0 and silent["recall"] == 1.0


def test_fixtures_are_well_formed() -> None:
    cases = load_cases()
    assert 6 <= len(cases) <= 10
    assert sum(case.is_clean for case in cases) >= 2
    for case in cases:
        assert (RECORDED_DIR / f"{case.name}.json").exists(), case.name
        assert (CASES_DIR / f"{case.name}.json").exists()
        for rule_id, path in case.expected:
            assert rule_id in RULES, rule_id
            assert path in case.files
        assert all(path.startswith("cloud/") for path in case.files)


def test_live_recording_predictions_survive_validation() -> None:
    case = next(case for case in load_cases() if case.name == "owner-from-body")
    recorded = json.loads((RECORDED_DIR / "owner-from-body.json").read_text(encoding="utf-8"))
    predictions = predictions_from_run(case, recorded)
    path = "cloud/apps/api/src/features/media/share-routes.ts"
    expected = {
        ("R5.owner-from-auth", path),
        ("R4.boundary-parse", path),
        ("G.dead-code", path),
        ("CORRECTNESS", path),
    }
    # Live Sol output (PRA-92): every finding quoted the diff, so validation dropped nothing.
    assert predictions["raw"] == expected
    assert predictions["posted"] == expected
    failed_session = predictions_from_run(case, {"sessions": {"security": None}, "gates": []})
    assert failed_session == {"raw": set(), "posted": set()}


def test_offline_run_scores_the_recorded_outputs() -> None:
    scores = run_offline()
    assert scores["cases"] == 10
    live = {"tp": 7, "fp": 15, "fn": 3, "precision": 0.318, "recall": 0.7}
    assert scores["raw"] == {**scores["raw"], **live}
    assert scores["posted"] == {**scores["posted"], **live}
    assert scores["clean_cases_with_findings"] == ["clean-refactor", "clean-ui-copy"]
    store = "cloud/apps/api/src/adapters/run-store.ts"
    assert scores["per_case"]["fail-open-store"] == {
        "missed": [("R3.fail-closed", store)],
        "unexpected": [("G.clean-break", store), ("R1.api-thin-routes", store), ("R3.root-cause", store)],
    }
    assert scores["per_case"]["mechanical-any-vm"]["missed"] == []

    text = format_scores(scores)
    assert "posted  precision 0.318  recall 0.700  (tp 7, fp 15, fn 3)" in text
    assert "clean cases that still got findings: ['clean-refactor', 'clean-ui-copy']" in text


def test_missing_expected_issue_lowers_recall() -> None:
    cases = load_cases()
    silent = {case.name: {"raw": set(), "posted": set()} for case in cases}
    scores = score_cases(cases, silent)
    assert scores["posted"]["recall"] == 0.0 and scores["posted"]["precision"] == 1.0
    assert scores["posted"]["fn"] == 10
