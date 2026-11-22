"""Eval harness: seeded-issue fixtures, and precision/recall of what the reviewer would post for them."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from diff_index import DiffIndex  # noqa: E402
from validation import raw_findings, validate_run  # noqa: E402

EVALS_DIR = Path(__file__).resolve().parent
CASES_DIR = EVALS_DIR / "cases"
RECORDED_DIR = EVALS_DIR / "recorded"

Label = tuple[str, str]


@dataclass(frozen=True)
class EvalCase:
    name: str
    files: dict[str, str]
    expected: frozenset[Label]
    linear: dict[str, str]
    raw: dict[str, Any]

    @property
    def is_clean(self) -> bool:
        return not self.expected


def load_cases(directory: Path = CASES_DIR) -> list[EvalCase]:
    cases: list[EvalCase] = []
    for path in sorted(directory.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        expected = frozenset((item["rule_id"], item["file"]) for item in raw["expected"])
        cases.append(
            EvalCase(
                name=raw["name"],
                files=raw["files"],
                expected=expected,
                linear=raw.get("linear", {}),
                raw=raw,
            )
        )
    return cases


def predictions_from_run(case: EvalCase, run: dict[str, Any]) -> dict[str, set[Label]]:
    """`raw` is everything the model said; `posted` is what survives validation, plus deterministic gate findings."""
    sessions = {name: payload for name, payload in (run.get("sessions") or {}).items() if payload is not None}
    raw: set[Label] = set()
    for payload in sessions.values():
        for finding in raw_findings(payload):
            if isinstance(finding, dict):
                raw.add((str(finding.get("rule_id")), str(finding.get("file"))))

    _, kept = validate_run(sessions, DiffIndex.from_new_files(case.files), case.linear)
    posted = {(finding["rule_id"], finding["file"]) for finding in kept}
    for gate in run.get("gates") or []:
        for finding in gate.get("findings") or []:
            label = (finding["rule_id"], finding["file"])
            posted.add(label)
            raw.add(label)
    return {"raw": raw, "posted": posted}


def _ratio(part: int, whole: int) -> float:
    """No predictions means nothing wrong was said (precision 1); no expectations means nothing was missed (recall 1)."""
    return round(part / whole, 3) if whole else 1.0


def score(expected: list[frozenset[Label]], predicted: list[set[Label]]) -> dict[str, Any]:
    by_rule: dict[str, dict[str, int]] = {}

    def bump(rule_id: str, key: str) -> None:
        by_rule.setdefault(rule_id, {"tp": 0, "fp": 0, "fn": 0})[key] += 1

    for want, got in zip(expected, predicted, strict=True):
        for rule_id, _ in want & got:
            bump(rule_id, "tp")
        for rule_id, _ in got - want:
            bump(rule_id, "fp")
        for rule_id, _ in want - got:
            bump(rule_id, "fn")

    tp = sum(counts["tp"] for counts in by_rule.values())
    fp = sum(counts["fp"] for counts in by_rule.values())
    fn = sum(counts["fn"] for counts in by_rule.values())
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "by_rule": dict(sorted(by_rule.items())),
    }


def score_cases(cases: list[EvalCase], predictions: dict[str, dict[str, set[Label]]]) -> dict[str, Any]:
    expected = [case.expected for case in cases]
    posted = [predictions[case.name]["posted"] for case in cases]
    raw = [predictions[case.name]["raw"] for case in cases]
    noisy_clean = [case.name for case, got in zip(cases, posted, strict=True) if case.is_clean and got]
    return {
        "cases": len(cases),
        "posted": score(expected, posted),
        "raw": score(expected, raw),
        "clean_cases_with_findings": noisy_clean,
        "per_case": {
            case.name: {
                "missed": sorted(case.expected - got),
                "unexpected": sorted(got - case.expected),
            }
            for case, got in zip(cases, posted, strict=True)
        },
    }


def run_offline(cases_dir: Path = CASES_DIR, recorded_dir: Path = RECORDED_DIR) -> dict[str, Any]:
    """Score recorded reviewer outputs; no model, no network."""
    cases = load_cases(cases_dir)
    predictions = {
        case.name: predictions_from_run(
            case, json.loads((recorded_dir / f"{case.name}.json").read_text(encoding="utf-8"))
        )
        for case in cases
    }
    return score_cases(cases, predictions)


def format_scores(scores: dict[str, Any]) -> str:
    lines = [f"Eval over {scores['cases']} case(s)"]
    for stage in ("raw", "posted"):
        result = scores[stage]
        lines.append(
            f"  {stage:<7} precision {result['precision']:.3f}  recall {result['recall']:.3f}  "
            f"(tp {result['tp']}, fp {result['fp']}, fn {result['fn']})"
        )
    lines.append(f"  clean cases that still got findings: {scores['clean_cases_with_findings'] or 'none'}")
    for name, detail in scores["per_case"].items():
        if detail["missed"] or detail["unexpected"]:
            lines.append(f"  {name}: missed {detail['missed']} unexpected {detail['unexpected']}")
    for rule_id, counts in scores["posted"]["by_rule"].items():
        lines.append(f"    {rule_id:<26} tp {counts['tp']} fp {counts['fp']} fn {counts['fn']}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(format_scores(run_offline()))
