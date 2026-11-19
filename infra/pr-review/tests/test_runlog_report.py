from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

from diff_index import DiffIndex
from linear import fetch_issue_texts, issue_text_from_response
from muse_output import ERROR_NOT_JSON, MuseOutput
from pipeline import STATUS_REVIEWED, RunState, SessionRun, assess, run_and_record
from redact import redact_text, redact_value
from report import format_report, summarize_runs
from runlog import RAW_OUTPUT_MAX_CHARS, RUN_RECORD_VERSION, load_run_records, run_record_path, write_run_record

PATH = "cloud/apps/api/src/routes.ts"
LINES = {12: "  const { userId, fileId } = await c.req.json();"}
SECRET = "lin_api_ABCDEFGHIJKLMNOPQRSTUVWX"


def make_state(run_id: str, pr_number: int, started_at: str) -> RunState:
    good = {
        "rule_id": "R5.owner-from-auth",
        "file": PATH,
        "line": 12,
        "evidence": LINES[12].strip(),
        "failure_scenario": "Any signed-in user can pass another user's id and read their file.",
        "suggestion": None,
        "confidence": "high",
        "linear_issue": None,
        "linear_quote": None,
    }
    paraphrased = {**good, "evidence": "user id comes from the body"}
    script_owned = {**good, "rule_id": "R4.no-any"}
    runs = [
        SessionRun(
            session="security",
            output=MuseOutput(
                payload={"session": "security", "findings": [good, paraphrased, script_owned]},
                error=None,
                final_text="{}",
                event_counts={"run.tool.step": 7},
                usage={"input_tokens": 900, "output_tokens": 80},
            ),
            raw_output=f"transcript mentioning {SECRET}",
            exit_code=0,
            duration_seconds=41.26,
        ),
        SessionRun(
            session="logic_bs",
            output=MuseOutput(payload=None, error=ERROR_NOT_JSON, final_text="prose"),
            raw_output="Looks fine to me!",
            exit_code=0,
            duration_seconds=12.0,
        ),
    ]
    gates = [
        {
            "key": "check-rules",
            "rule_id": "GATE.check-rules",
            "status": "failed",
            "exit_code": 1,
            "duration_seconds": 0.4,
            "error": None,
            "output_tail": "x",
            "findings": [{"rule_id": "R4.no-any", "file": PATH, "line": 12, "message": "raw any"}],
        }
    ]
    result = assess(
        session_runs=runs,
        gates=gates,
        diff=DiffIndex(files={PATH: LINES}),
        linear_texts={},
        model="muse-ember-1.0",
    )
    state = RunState(
        run_id=run_id,
        repo="wapo-org/praxis",
        pr_number=pr_number,
        trigger="pull_request:opened",
        model="muse-ember-1.0",
        reasoning_effort="max",
        started_at=started_at,
        head_sha="abcdef1234567",
        token_kind="fine_grained_pat",
    )
    state.gates = gates
    state.session_runs = runs
    state.validations = result.validations
    state.posted_findings = result.findings
    state.verdict = result.review["verdict"]
    state.review_id = 99
    state.status = STATUS_REVIEWED
    return state


def test_run_record_format_and_redaction(tmp_path: Path) -> None:
    state = make_state("run-a", 7, "2026-11-16T10:00:00Z")
    result = run_and_record(
        state,
        lambda run: {"status": run.status},
        lambda record: write_run_record(tmp_path, record),
        elapsed=lambda: 61.0,
        secrets=(SECRET,),
    )
    assert result == {"status": STATUS_REVIEWED}

    path = run_record_path(tmp_path, state.to_record())
    assert path == tmp_path / "wapo-org_praxis" / "pr-7" / "2026-11-16T100000Z-abcdef1-run-a.json"
    record = json.loads(path.read_text(encoding="utf-8"))

    assert set(record) == {
        "version", "run_id", "repo", "pr_number", "head_sha", "trigger", "model", "reasoning_effort",
        "github_token_kind", "started_at", "duration_seconds", "status", "error", "verdict", "review_id",
        "gates", "sessions", "posted_findings",
    }  # fmt: skip
    assert record["version"] == RUN_RECORD_VERSION
    assert record["verdict"] == "REQUEST_CHANGES" and record["duration_seconds"] == 61.0
    assert [finding["rule_id"] for finding in record["posted_findings"]] == ["R5.owner-from-auth"]

    security, logic = record["sessions"]
    assert set(security) == {
        "session", "ok", "error", "exit_code", "duration_seconds", "steps", "usage", "event_counts",
        "raw_output", "parsed_findings", "kept_findings", "dropped_findings",
    }  # fmt: skip
    assert security["ok"] is True and security["steps"] == 7
    assert security["usage"] == {"input_tokens": 900, "output_tokens": 80}
    assert len(security["parsed_findings"]) == 3 and len(security["kept_findings"]) == 1
    assert [dropped["reason"] for dropped in security["dropped_findings"]] == ["evidence_not_found", "script_owned_rule"]
    assert security["raw_output"] == "transcript mentioning [REDACTED]"
    assert logic["ok"] is False and logic["error"] == ERROR_NOT_JSON
    assert logic["raw_output"] == "Looks fine to me!" and logic["parsed_findings"] == []
    assert SECRET not in path.read_text(encoding="utf-8")


def test_raw_output_is_capped_and_records_load_newest_first(tmp_path: Path) -> None:
    old = make_state("old", 7, "2026-11-15T09:00:00Z")
    old.session_runs[0].raw_output = "x" * (RAW_OUTPUT_MAX_CHARS + 500)
    new = make_state("new", 8, "2026-11-16T09:00:00Z")
    for state in (old, new):
        write_run_record(tmp_path, state.to_record())
    (tmp_path / "junk.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "foreign.json").write_text('{"version": 0}', encoding="utf-8")

    records = load_run_records(tmp_path, limit=10)
    assert [record["run_id"] for record in records] == ["new", "old"]
    assert len(records[1]["sessions"][0]["raw_output"]) == RAW_OUTPUT_MAX_CHARS
    assert [record["run_id"] for record in load_run_records(tmp_path, limit=1)] == ["new"]
    assert load_run_records(tmp_path / "missing", limit=5) == []


def test_slop_report_summarises_drops_rules_and_wont_fix() -> None:
    records: list[dict[str, Any]] = [
        make_state("a", 7, "2026-11-16T10:00:00Z").to_record(),
        make_state("b", 8, "2026-11-16T11:00:00Z").to_record(),
    ]
    failed = make_state("c", 8, "2026-11-16T12:00:00Z")
    failed.status, failed.error, failed.verdict = "error", "GitHubAuthError: GitHub returned 403", None
    failed.session_runs, failed.validations, failed.posted_findings, failed.gates = [], [], [], []
    records.append(failed.to_record())

    outcomes = [
        {"rule_id": "R5.owner-from-auth", "outcome": "wont_fix"},
        {"rule_id": "R5.owner-from-auth", "outcome": "resolved"},
        {"rule_id": "R4.no-any", "outcome": "open"},
        {"rule_id": "R4.no-any", "outcome": "resolved"},
    ]
    summary = summarize_runs(records, outcomes)
    assert summary["runs"] == 3
    assert summary["statuses"] == {"reviewed": 2, "error": 1}
    assert summary["verdicts"] == {"REQUEST_CHANGES": 2}
    assert (summary["findings_parsed"], summary["findings_dropped"], summary["findings_posted"]) == (6, 4, 2)
    assert summary["drop_rate"] == 0.667
    assert summary["dropped_by_reason"] == {"evidence_not_found": 2, "script_owned_rule": 2}
    assert summary["drop_rate_by_session"] == {"logic_bs": 0.0, "security": 0.667}
    assert summary["session_failure_rate"] == {"logic_bs": 1.0, "security": 0.0}
    assert summary["findings_per_pr"] == {"wapo-org/praxis#7": 1, "wapo-org/praxis#8": 1}
    assert summary["findings_per_pr_mean"] == 1.0
    assert summary["rule_frequency"] == {"R5.owner-from-auth": 2, "R4.no-any": 2}
    assert summary["gate_failures"] == {"check-rules": 2}
    assert summary["wont_fix"] == {"threads": 4, "wont_fix": 1, "share": 0.25, "by_rule": {"R5.owner-from-auth": 1}}
    assert summary["run_errors"] == [{"run_id": "c", "pr_number": 8, "error": "GitHubAuthError: GitHub returned 403"}]

    text = format_report(summary)
    assert "6 parsed, 4 dropped (66.7%), 2 posted" in text
    assert "Won't-fix share: 1/4 threads (25.0%)" in text
    assert "RUN ERROR pr #8 (c): GitHubAuthError" in text

    without_threads = summarize_runs(records)
    assert without_threads["wont_fix"] is None
    assert "Won't-fix share: not collected" in format_report(without_threads)
    assert summarize_runs([])["drop_rate"] == 0.0


def test_redaction_covers_known_values_and_token_shapes() -> None:
    text = "key=hunter2hunter2 gho_ABCDEFGHIJKLMNOPQRSTUVWX github_pat_11ABCDEFGHIJKLMNOPQRSTU Bearer abcdefghijklmnopqrstuvwxyz short=abc"
    cleaned = redact_text(text, secrets=("hunter2hunter2", "abc", ""))
    assert cleaned == "key=[REDACTED] [REDACTED] [REDACTED] [REDACTED] short=abc"
    nested = redact_value({"a": ["sk-ABCDEFGHIJKLMNOPQRSTUVWX", 3], "b": {"c": "fine"}})
    assert nested == {"a": ["[REDACTED]", 3], "b": {"c": "fine"}}


def test_linear_issue_text_is_fetched_server_side_for_quote_checks() -> None:
    response = {
        "data": {
            "issues": {
                "nodes": [
                    {
                        "identifier": "PRA-41",
                        "title": "Retire the public Hono surface",
                        "description": "No client-facing route stays on Vercel.",
                        "comments": {"nodes": [{"body": "Decision: keep /api/turn."}]},
                    }
                ]
            }
        }
    }
    assert issue_text_from_response(response) == (
        "Retire the public Hono surface\n\nNo client-facing route stays on Vercel.\n\nDecision: keep /api/turn."
    )
    assert issue_text_from_response({"data": {"issues": {"nodes": []}}}) == ""

    seen: list[tuple[str, int]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        number = json.loads(request.content)["variables"]["num"]
        seen.append((request.headers["Authorization"], number))
        if number == 13:
            return httpx.Response(500)
        return httpx.Response(200, json=response if number == 41 else {"data": {"issues": {"nodes": []}}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        texts = fetch_issue_texts(client, "lin_key", ["PRA-41", "PRA-13", "PRA-7", "not-an-id"])
        assert fetch_issue_texts(client, "", ["PRA-41"]) == {}
    assert list(texts) == ["PRA-41"]
    assert seen == [("lin_key", 41), ("lin_key", 13), ("lin_key", 7)]
