"""Slop report: summarise persisted runs so reviewer quality is visible over time."""

from __future__ import annotations

from collections import Counter
from typing import Any

DEFAULT_REPORT_RUNS = 50
OUTCOME_WONT_FIX = "wont_fix"


def _rate(part: int, whole: int) -> float:
    return round(part / whole, 3) if whole else 0.0


def summarize_runs(
    records: list[dict[str, Any]],
    thread_outcomes: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """`thread_outcomes` are `{rule_id, outcome}` rows from GitHub review threads; None means not collected."""
    parsed_by_session: Counter[str] = Counter()
    dropped_by_session: Counter[str] = Counter()
    dropped_by_reason: Counter[str] = Counter()
    session_runs: Counter[str] = Counter()
    session_failures: Counter[str] = Counter()
    rule_counts: Counter[str] = Counter()
    gate_failures: Counter[str] = Counter()
    verdicts: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    posted_by_pr: Counter[str] = Counter()
    errors: list[dict[str, Any]] = []

    for record in records:
        statuses[str(record.get("status"))] += 1
        if record.get("verdict"):
            verdicts[str(record["verdict"])] += 1
        if record.get("error"):
            errors.append({"run_id": record.get("run_id"), "pr_number": record.get("pr_number"), "error": record["error"]})

        pr_key = f"{record.get('repo')}#{record.get('pr_number')}"
        posted = record.get("posted_findings") or []
        posted_by_pr[pr_key] += len(posted)
        rule_counts.update(str(finding.get("rule_id")) for finding in posted)

        for gate in record.get("gates") or []:
            if gate.get("status") == "failed":
                gate_failures[str(gate.get("key"))] += 1
            rule_counts.update(str(finding.get("rule_id")) for finding in gate.get("findings") or [])

        for session in record.get("sessions") or []:
            name = str(session.get("session"))
            session_runs[name] += 1
            if not session.get("ok"):
                session_failures[name] += 1
            parsed_by_session[name] += len(session.get("parsed_findings") or [])
            for dropped in session.get("dropped_findings") or []:
                dropped_by_session[name] += 1
                dropped_by_reason[str(dropped.get("reason"))] += 1

    parsed_total = sum(parsed_by_session.values())
    dropped_total = sum(dropped_by_session.values())
    posted_total = sum(posted_by_pr.values())

    summary: dict[str, Any] = {
        "runs": len(records),
        "statuses": dict(statuses),
        "verdicts": dict(verdicts),
        "run_errors": errors,
        "findings_parsed": parsed_total,
        "findings_dropped": dropped_total,
        "findings_posted": posted_total,
        "drop_rate": _rate(dropped_total, parsed_total),
        "dropped_by_reason": dict(dropped_by_reason.most_common()),
        "drop_rate_by_session": {
            name: _rate(dropped_by_session[name], parsed_by_session[name]) for name in sorted(parsed_by_session)
        },
        "session_failure_rate": {
            name: _rate(session_failures[name], session_runs[name]) for name in sorted(session_runs)
        },
        "findings_per_pr": dict(posted_by_pr),
        "findings_per_pr_mean": round(posted_total / len(posted_by_pr), 2) if posted_by_pr else 0.0,
        "rule_frequency": dict(rule_counts.most_common()),
        "gate_failures": dict(gate_failures),
        "wont_fix": None,
    }

    if thread_outcomes is not None:
        wont_fix = [row for row in thread_outcomes if row.get("outcome") == OUTCOME_WONT_FIX]
        summary["wont_fix"] = {
            "threads": len(thread_outcomes),
            "wont_fix": len(wont_fix),
            "share": _rate(len(wont_fix), len(thread_outcomes)),
            "by_rule": dict(Counter(str(row.get("rule_id")) for row in wont_fix).most_common()),
        }
    return summary


def _table(title: str, rows: dict[str, Any]) -> list[str]:
    lines = [title]
    if not rows:
        lines.append("  (none)")
    lines.extend(f"  {key:<28} {value}" for key, value in rows.items())
    return lines


def format_report(summary: dict[str, Any]) -> str:
    lines = [
        f"Slop report over {summary['runs']} run(s)",
        f"  statuses: {summary['statuses']}   verdicts: {summary['verdicts']}",
        f"  findings: {summary['findings_parsed']} parsed, {summary['findings_dropped']} dropped "
        f"({summary['drop_rate']:.1%}), {summary['findings_posted']} posted "
        f"(mean {summary['findings_per_pr_mean']} per PR)",
        "",
    ]
    lines.extend(_table("Dropped by reason", summary["dropped_by_reason"]))
    lines.extend(_table("Drop rate by session", summary["drop_rate_by_session"]))
    lines.extend(_table("Sessions with no usable output (rate)", summary["session_failure_rate"]))
    lines.extend(_table("Rule frequency (posted + gates)", summary["rule_frequency"]))
    lines.extend(_table("Gate failures", summary["gate_failures"]))
    lines.extend(_table("Posted findings per PR", summary["findings_per_pr"]))

    wont_fix = summary.get("wont_fix")
    if wont_fix is None:
        lines.append("Won't-fix share: not collected (run with GitHub thread lookup)")
    else:
        lines.append(
            f"Won't-fix share: {wont_fix['wont_fix']}/{wont_fix['threads']} threads "
            f"({wont_fix['share']:.1%}) by rule {wont_fix['by_rule']}"
        )
    for error in summary["run_errors"]:
        lines.append(f"RUN ERROR pr #{error['pr_number']} ({error['run_id']}): {error['error']}")
    return "\n".join(lines)
