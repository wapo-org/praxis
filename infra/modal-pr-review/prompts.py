from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEFAULT_MUSE_MODEL = "muse-ember-1.0"
DEFAULT_MUSE_REASONING_EFFORT = "max"
DEFAULT_MUSE_MAX_MODEL_STEPS = "80"

INSTALLED_PSTACK_SKILLS: tuple[str, ...] = (
    "architect",
    "blast-radius",
    "how",
    "interrogate",
    "no-comments",
    "principle-attack-the-premise",
    "principle-boundary-discipline",
    "principle-encode-lessons-in-structure",
    "principle-explain-the-number",
    "principle-fix-root-causes",
    "principle-foundational-thinking",
    "principle-make-operations-idempotent",
    "principle-migrate-callers-then-delete-legacy-apis",
    "principle-minimize-reader-load",
    "principle-model-the-domain",
    "principle-prove-it-works",
    "principle-subtract-before-you-add",
    "principle-type-system-discipline",
    "typescript-best-practices",
    "unslop",
    "why",
)


@dataclass(frozen=True)
class SessionProfile:
    key: str
    label: str
    read_only: bool
    skills: tuple[str, ...]
    mission: str
    focus_checks: tuple[str, ...]


REVIEW_SESSION_PROFILES: tuple[SessionProfile, ...] = (
    SessionProfile(
        key="abstractions",
        label="Abstractions & Constants",
        read_only=True,
        skills=(
            "principle-boundary-discipline",
            "principle-model-the-domain",
            "principle-type-system-discipline",
            "principle-foundational-thinking",
            "typescript-best-practices",
            "architect",
        ),
        mission=(
            "Evaluate layer boundaries, pluggable/unpluggable modularity, domain modeling, "
            "type-level invariants, and whether static text/numbers belong as named constants "
            "in their owning abstraction layer."
        ),
        focus_checks=(
            "Check unidirectional boundaries: @praxis/protocol (pure Zod), @praxis/agent (ports only), "
            "@praxis/credentials (all multi-key/cooldown/sticky flows), AdapterBundle/FeatureModule "
            "in cloud/apps/api, and @praxis/glass <-> Tokens.swift parity.",
            "Flag inline magic strings, routes, header/cookie names, Redis key prefixes, timeouts, "
            "limits, or UI literals that belong as named constants (with units like _MS/_BYTES) in "
            "their owning module/layer.",
            "Check for leaky abstractions, optional-field bags instead of discriminated unions, "
            "missing Zod/boundary parsing, raw `any` / `v.any()`, or unbranded IDs crossing external client seams.",
        ),
    ),
    SessionProfile(
        key="maintainability",
        label="Maintainability & Linear Alignment",
        read_only=True,
        skills=(
            "blast-radius",
            "principle-migrate-callers-then-delete-legacy-apis",
            "principle-minimize-reader-load",
            "principle-make-operations-idempotent",
            "how",
            "why",
        ),
        mission=(
            "Assess long-term maintenance cost, cross-file/cross-client blast radius, clean-break "
            "completeness, and alignment with Linear PRA-* issue specs and acceptance criteria."
        ),
        focus_checks=(
            "Trace callers and sibling implementations across cloud/ and PraxisChat/ beyond the diff.",
            "Check file-size discipline (~400 lines max), compressed single-line statements that obscure "
            "control flow, and unnecessary indirections that increase reader load.",
            "Enforce clean-break pre-launch policy (PRA-73): spot unrequested backward-compatibility shims, "
            "un-migrated callers, or stale docs in cloud/ARCHITECTURE.md / cloud/docs/function-maps/*.",
            "Verify the PR against relevant Linear PRA-* tasks via Linear MCP or `linear-read`.",
        ),
    ),
    SessionProfile(
        key="conciseness",
        label="Conciseness & Comment Hygiene",
        read_only=True,
        skills=(
            "no-comments",
            "principle-subtract-before-you-add",
            "principle-minimize-reader-load",
            "unslop",
        ),
        mission=(
            "Identify code that can be shorter and clearer, dead code, single-caller wrappers, "
            "verbose/narrating comments, and AI-slop prose."
        ),
        focus_checks=(
            "Look for repetitive boilerplate, redundant validators inside trusted boundaries, "
            "dead exports/helpers, or multi-layer pass-through wrappers that can be collapsed.",
            "Check comments against AGENTS.md & comment-sweep.mjs rules: keep only <=130-char one-line "
            "'why / invariant' comments; surface narrating or verbose comments as concise removal/rewrite offers.",
            "Flag unrequested summary/plan .md files or bloated prose in docs/PR text.",
            "Note: Do NOT edit files or spawn subagents; convert skill criteria into review findings.",
        ),
    ),
    SessionProfile(
        key="logic_bs",
        label="Logic, Efficiency & Bullshit Detection",
        read_only=True,
        skills=(
            "principle-fix-root-causes",
            "principle-attack-the-premise",
            "principle-explain-the-number",
            "principle-prove-it-works",
            "interrogate",
        ),
        mission=(
            "Detect illogical or inefficient decisions, band-aid/symptom fixes, unjustified numbers, "
            "race conditions, and unsubstantiated claims or drift from Linear PRA-* specs."
        ),
        focus_checks=(
            "Challenge band-aid fixes (arbitrary setTimeout/sleep waits, retry masks, swallowing errors, "
            "defensive fallbacks hiding upstream bugs) instead of root-cause fixes.",
            "Inspect I/O and algorithmic efficiency: N+1 queries, Convex streaming/full-doc I/O bloat (PRA-80), "
            "split-brain caching, unindexed scans, or unbounded loops/buffers.",
            "Verify numeric constants/thresholds have a sound rationale and check cross-file invariants "
            "(idempotency, CAS revisions, cancel propagation, reconnect replay).",
            "Cross-check PR claims against actual code behavior and Linear PRA-* task expectations.",
        ),
    ),
    SessionProfile(
        key="security",
        label="Security, Isolation & Secrets",
        read_only=True,
        skills=(
            "principle-boundary-discipline",
            "principle-type-system-discipline",
            "blast-radius",
            "principle-fix-root-causes",
            "interrogate",
        ),
        mission=(
            "Audit tenant/owner isolation, secret handling, SSRF egress, execution boundaries, "
            "taint propagation, and fail-closed production invariants."
        ),
        focus_checks=(
            "Verify userId/owner comes strictly from verified auth/session context, never client parameters (PRA-35).",
            "Verify secrets/keys/tokens never leak into logs, API payloads, URLs, Redis keys, or telemetry (PRA-23, PRA-61).",
            "Check SSRF egress protection for user URLs, banned primitives in cloud/apps/api "
            "(child_process, eval, new Function, vm, worker_threads), and fail-closed production startup.",
            "Inspect tool/approval/taint boundaries (PRA-56, PRA-57, PRA-76): inner-action classification "
            "for wrapper tools, shell AST vs regex evasion, and spend pre-reservation (PRA-22, PRA-81).",
        ),
    ),
)

HANDS_ON_SESSION_PROFILE = SessionProfile(
    key="hands_on",
    label="Hands-On App Testing",
    read_only=False,
    skills=(
        "principle-prove-it-works",
        "principle-fix-root-causes",
    ),
    mission=(
        "Run repo verification gates, boot the live cloud/ API and React/Vite web app inside the sandbox, "
        "and test the app by hand via HTTP and headless Chromium (Playwright)."
    ),
    focus_checks=(
        "Run `npm --prefix cloud run typecheck`, `npm --prefix cloud test`, and `node cloud/scripts/comment-sweep.mjs check`.",
        "Start local API (`PORT=8797 npm --prefix cloud run dev:local`) and Vite web (`VITE_API_PROXY_TARGET=http://127.0.0.1:8797 npm --prefix cloud/apps/web run dev -- --port 5173 --host 127.0.0.1`), wait for `/health` and `:5173`.",
        "Run `PORT=8797 npm --prefix cloud/apps/api run smoke:local` and `BASE=http://127.0.0.1:5173 API=http://127.0.0.1:8797 node cloud/apps/web/scripts/p0-check.mjs`.",
        "Write and execute `/tmp/hands_on_test.mjs` (never modifying `/workspace/repo`) using Playwright Chromium (`NODE_PATH=/workspace/repo/cloud/node_modules`) to interactively test PR-changed flows and check console/page/network errors.",
        "If PraxisChat/ Swift files changed, state clearly that Xcode Simulator cannot run on Linux.",
    ),
)

REVIEW_SESSION_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["session", "blocking_issues", "summary", "linear_checks", "findings"],
    "properties": {
        "session": {"type": "string"},
        "blocking_issues": {
            "type": "boolean",
            "description": "True only for objective bugs, security issues, failing checks, explicit AGENTS.md hard-boundary violations, or direct Linear spec contradictions.",
        },
        "summary": {"type": "string"},
        "linear_checks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["issue_id", "status", "note"],
                "properties": {
                    "issue_id": {"type": "string"},
                    "status": {
                        "type": "string",
                        "enum": ["aligned", "concern", "contradiction", "not_applicable"],
                    },
                    "note": {"type": "string"},
                },
            },
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "severity",
                    "tone",
                    "path",
                    "line",
                    "title",
                    "body",
                    "suggestion",
                    "rule_or_issue",
                ],
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "major", "minor", "nit"],
                    },
                    "tone": {
                        "type": "string",
                        "enum": ["question_offer", "hard_boundary_flag"],
                    },
                    "path": {"type": ["string", "null"]},
                    "line": {"type": ["integer", "null"]},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "suggestion": {"type": ["string", "null"]},
                    "rule_or_issue": {"type": ["string", "null"]},
                },
            },
        },
    },
}

HANDS_ON_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "ran",
        "environment",
        "checks_passed",
        "checks_failed",
        "manual_observations",
        "findings",
    ],
    "properties": {
        "ran": {"type": "boolean"},
        "environment": {"type": "string"},
        "checks_passed": {"type": "array", "items": {"type": "string"}},
        "checks_failed": {"type": "array", "items": {"type": "string"}},
        "manual_observations": {"type": "string"},
        "findings": REVIEW_SESSION_OUTPUT_SCHEMA["properties"]["findings"],
    },
}


def _shared_pr_header(
    *,
    repo: str,
    pr_number: int,
    title: str,
    body: str,
    base_ref: str,
    head_ref: str,
    head_sha: str,
    changed_files: list[str],
    custom_instructions: str,
) -> str:
    files_block = "\n".join(f"- {path}" for path in changed_files[:200])
    if len(changed_files) > 200:
        files_block += f"\n- ... ({len(changed_files) - 200} more files)"

    custom_section = ""
    if custom_instructions.strip():
        custom_section = f"\n## Extra Instructions from PR Comment\n{custom_instructions.strip()}\n"

    return f"""Pull Request #{pr_number} on `{repo}` inside an isolated Linux Modal Sandbox.

## PR Metadata
- **Title:** {title}
- **Base -> Head:** `{base_ref}` -> `{head_ref}` (`{head_sha}`)
- **Changed Files ({len(changed_files)}):**
{files_block}

## PR Description
{body.strip() or "(No description provided.)"}
{custom_section}"""


def build_session_prompt(
    profile: SessionProfile,
    *,
    repo: str,
    pr_number: int,
    title: str,
    body: str,
    base_ref: str,
    head_ref: str,
    head_sha: str,
    changed_files: list[str],
    custom_instructions: str = "",
) -> str:
    header = _shared_pr_header(
        repo=repo,
        pr_number=pr_number,
        title=title,
        body=body,
        base_ref=base_ref,
        head_ref=head_ref,
        head_sha=head_sha,
        changed_files=changed_files,
        custom_instructions=custom_instructions,
    )
    skill_paths = "\n".join(
        f"- `/root/.config/muse/skills/{s}/SKILL.md`" for s in profile.skills
    )
    checks_block = "\n".join(f"- {item}" for item in profile.focus_checks)

    return f"""You are the **{profile.label}** (`{profile.key}`) reviewer for {header}

## Mandatory First Steps
1. Read `AGENTS.md` and `infra/modal-pr-review/REVIEW_GUIDELINES.md` (if present in `/workspace/repo`).
2. You MUST read and apply all of your assigned skills before inspecting the diff:
{skill_paths}
   (Note: this is a read-only review session — do NOT edit repository files or spawn subagents; convert any skill action items into concrete review findings.)
3. Inspect the PR diff (`git diff origin/{base_ref}...HEAD` and `git diff --stat origin/{base_ref}...HEAD`) AND read surrounding cross-file callers/contracts (`cloud/packages/*`, `cloud/apps/*`, `PraxisChat/*`) so you catch cross-file issues outside the diff lines.
4. Use your read-only `linear` MCP server (and/or `/usr/local/bin/linear-read` in shell) to check matching Linear `PRA-*` issues referenced in the PR title/branch/commits or related architecture epics (`PRA-72`–`PRA-81`) to verify requirements, scope, and architectural decisions.

## Your Specialized Mission
{profile.mission}

## Specific Checks for `{profile.key}`
{checks_block}

## Non-Opinionated Communication Posture (CRITICAL)
- You are running on a compact review model (`muse-ember-1.0`). Do NOT issue opinionated orders or preach style preferences.
- Frame subjective architecture, abstraction, refactoring, and conciseness ideas as humble questions or options (`"Could we extract...?"`, `"Have you considered...?"`, `"Option A / Option B..."`), setting `tone: "question_offer"`.
- Reserve `tone: "hard_boundary_flag"` and `blocking_issues: true` ONLY for objective security/logic bugs or explicit violations of `AGENTS.md` HARD boundaries / Linear `PRA-*` specs, citing the exact `path:line`, rule, or Linear issue ID in `rule_or_issue`.
- Set `session` to `"{profile.key}"` in your JSON response.
"""


def build_hands_on_prompt(
    *,
    repo: str,
    pr_number: int,
    title: str,
    body: str,
    base_ref: str,
    head_ref: str,
    head_sha: str,
    changed_files: list[str],
    custom_instructions: str = "",
) -> str:
    header = _shared_pr_header(
        repo=repo,
        pr_number=pr_number,
        title=title,
        body=body,
        base_ref=base_ref,
        head_ref=head_ref,
        head_sha=head_sha,
        changed_files=changed_files,
        custom_instructions=custom_instructions,
    )
    skill_paths = "\n".join(
        f"- `/root/.config/muse/skills/{s}/SKILL.md`"
        for s in HANDS_ON_SESSION_PROFILE.skills
    )
    checks_block = "\n".join(
        f"- {item}" for item in HANDS_ON_SESSION_PROFILE.focus_checks
    )

    return f"""You are the **Hands-On App Tester** (`hands_on`) for {header}

## Mandatory First Steps
1. Read `AGENTS.md` and your assigned skills:
{skill_paths}
2. Inspect `git diff --stat origin/{base_ref}...HEAD` to see which API routes, web UI flows, or Swift files changed.
3. Do NOT edit files inside `/workspace/repo`; place any temporary Playwright test script in `/tmp/hands_on_test.mjs` and clean up background servers before exiting.

## Hands-On Verification Checklist
{checks_block}

## Reporting Rules
- Record exact commands run in `checks_passed` / `checks_failed` and concrete observations (status codes, console/network errors, UI assertions, or Linux/Xcode note) in `manual_observations`.
- Only report issues directly observed from actual command/browser runs.
"""
