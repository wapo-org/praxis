"""Pure glue between raw session output and the posted review; shared by PR reviews, evals and tests."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from typing import Any

from diff_index import DiffIndex
from muse_output import MuseOutput
from redact import redact_text, redact_value
from review import CODE_REVIEW_SESSIONS, build_review
from runlog import build_run_record, session_record
from validation import SessionValidation, validate_run
from visual_review import VisualAssessment

STATUS_REVIEWED = "reviewed"
STATUS_SKIPPED = "skipped"
STATUS_ERROR = "error"
RUN_ERROR_MAX_CHARS = 1000


@dataclass
class SessionRun:
    session: str
    output: MuseOutput
    raw_output: str
    exit_code: int | None
    duration_seconds: float
    visual: VisualAssessment | None = None


@dataclass
class Assessment:
    review: dict[str, Any]
    validations: list[SessionValidation]
    findings: list[dict[str, Any]]
    session_errors: dict[str, str]


@dataclass
class RunState:
    """Everything a run record needs, filled in as the run proceeds so a crash still leaves evidence."""

    run_id: str
    repo: str
    pr_number: int
    trigger: str
    model: str
    reasoning_effort: str
    started_at: str
    head_sha: str = ""
    token_kind: str = "unknown"
    status: str = STATUS_ERROR
    error: str | None = None
    verdict: str | None = None
    review_id: int | None = None
    duration_seconds: float = 0.0
    gates: list[dict[str, Any]] = field(default_factory=list)
    session_runs: list[SessionRun] = field(default_factory=list)
    validations: list[SessionValidation] = field(default_factory=list)
    posted_findings: list[dict[str, Any]] = field(default_factory=list)

    def to_record(self, secrets: Iterable[str] = ()) -> dict[str, Any]:
        by_session = {validation.session: validation for validation in self.validations}
        sessions = [
            session_record(
                session=run.session,
                raw_output=run.raw_output,
                error=run.output.error,
                exit_code=run.exit_code,
                duration_seconds=run.duration_seconds,
                steps=run.output.steps,
                usage=run.output.usage,
                event_counts=run.output.event_counts,
                validation=by_session.get(run.session),
            )
            for run in self.session_runs
        ]
        for run, record in zip(self.session_runs, sessions):
            if run.visual is not None:
                record["visual"] = asdict(run.visual)
                record["visual"]["inconsistencies"] = [list(item) for item in run.visual.inconsistencies]
        return build_run_record(
            run_id=self.run_id,
            repo=self.repo,
            pr_number=self.pr_number,
            head_sha=self.head_sha,
            trigger=self.trigger,
            model=self.model,
            reasoning_effort=self.reasoning_effort,
            token_kind=self.token_kind,
            started_at=self.started_at,
            duration_seconds=self.duration_seconds,
            status=self.status,
            error=self.error,
            verdict=self.verdict,
            review_id=self.review_id,
            gates=self.gates,
            sessions=sessions,
            posted_findings=self.posted_findings,
            secrets=secrets,
        )


def _session_summaries(
    session_runs: list[SessionRun],
    validations: list[SessionValidation],
) -> dict[str, str]:
    by_session = {v.session: v for v in validations}
    runs_by_session = {r.session: r for r in session_runs}
    summaries: dict[str, str] = {}
    for key in CODE_REVIEW_SESSIONS:
        run = runs_by_session.get(key)
        if run is None:
            continue
        if run.output.error:
            summaries[key] = f"session error ({run.output.error})"
            continue
        kept_count = len(by_session[key].kept) if key in by_session else 0
        raw_summary = ""
        if isinstance(run.output.payload, dict) and isinstance(run.output.payload.get("summary"), str):
            raw_summary = " ".join(run.output.payload["summary"].split())[:80]
        if kept_count:
            noun = "finding" if kept_count == 1 else "findings"
            summaries[key] = f"{kept_count} {noun} posted" + (f" ({raw_summary})" if raw_summary else "")
        else:
            summaries[key] = raw_summary or "Looks okay"
    return summaries


def assess(
    *,
    session_runs: list[SessionRun],
    gates: list[dict[str, Any]],
    diff: DiffIndex,
    linear_texts: dict[str, str],
    model: str,
    secrets: Iterable[str] = (),
    run_id: str | None = None,
    head_sha: str = "",
    reviewed_file_count: int | None = None,
) -> Assessment:
    """Validate what the sessions returned and build the review; a failed session contributes nothing but a note."""
    payloads = {run.session: run.output.payload for run in session_runs if run.output.payload is not None}
    session_errors = {run.session: run.output.error for run in session_runs if run.output.error}
    validations, findings = validate_run(payloads, diff, linear_texts)
    review = build_review(
        gates=gates,
        findings=findings,
        hands_on=payloads.get("hands_on"),
        diff=diff,
        visual=next((run.visual for run in session_runs if run.visual is not None), None),
        run_id=run_id,
        head_sha=head_sha,
        reviewed_file_count=reviewed_file_count,
        session_summaries=_session_summaries(session_runs, validations),
    )
    return Assessment(
        review=redact_value(review, secrets),
        validations=validations,
        findings=findings,
        session_errors=session_errors,
    )


def run_and_record(
    state: RunState,
    run: Callable[[RunState], dict[str, Any]],
    persist: Callable[[dict[str, Any]], None],
    *,
    elapsed: Callable[[], float],
    secrets: Iterable[str] = (),
) -> dict[str, Any]:
    """Run a review and always persist a record; any failure is written down and re-raised, never swallowed."""
    known = tuple(secrets)
    try:
        result = run(state)
    except Exception as exc:
        state.status = STATUS_ERROR
        state.error = redact_text(f"{type(exc).__name__}: {exc}", known)[:RUN_ERROR_MAX_CHARS]
        state.duration_seconds = elapsed()
        persist(state.to_record(known))
        raise
    state.duration_seconds = elapsed()
    persist(state.to_record(known))
    return result
