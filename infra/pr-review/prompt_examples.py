"""Worked examples shown to each session: what a postable finding looks like, and what gets rejected."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Example:
    good: bool
    why: str
    finding: dict[str, Any]


def _finding(
    rule_id: str,
    file: str,
    line: int,
    evidence: str,
    failure_scenario: str,
    suggestion: str | None,
    confidence: str = "high",
    linear_issue: str | None = None,
    linear_quote: str | None = None,
) -> dict[str, Any]:
    return {
        "rule_id": rule_id,
        "file": file,
        "line": line,
        "evidence": evidence,
        "failure_scenario": failure_scenario,
        "suggestion": suggestion,
        "confidence": confidence,
        "linear_issue": linear_issue,
        "linear_quote": linear_quote,
    }


SESSION_EXAMPLES: dict[str, tuple[Example, ...]] = {
    "abstractions": (
        Example(
            good=True,
            why="Quotes the changed line, names who breaks and how.",
            finding=_finding(
                "R4.boundary-parse",
                "cloud/apps/api/src/features/media/routes.ts",
                41,
                "const body = (await c.req.json()) as UploadRequest;",
                "A client that sends `{size: \"12\"}` passes the cast, and `size > LIMIT` then compares a string, so the size limit is skipped.",
                "Would parsing with the `UploadRequestSchema` from @praxis/protocol here work?",
            ),
        ),
        Example(
            good=True,
            why="Cross-layer value duplicated inline; framed as a question because it is not a HARD rule.",
            finding=_finding(
                "R2.shared-constant",
                "cloud/apps/web/src/lib/api-transport.ts",
                88,
                "headers: { 'x-praxis-run-token': token },",
                "The API reads this header name from its own literal, so renaming it on one side makes every run request fail auth with no type error.",
                "Could both sides import one header-name constant from @praxis/protocol?",
                confidence="medium",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: UI copy stays in components, the evidence is a paraphrase instead of a quote, and no failure is described.",
            finding=_finding(
                "R2.shared-constant",
                "cloud/apps/web/src/components/EmptyState.tsx",
                12,
                "the empty state text is hard-coded",
                "Magic strings are bad practice.",
                "Move all strings to constants.",
            ),
        ),
    ),
    "maintainability": (
        Example(
            good=True,
            why="Clean-break rule: a compatibility shim was added although there are no production users.",
            finding=_finding(
                "G.clean-break",
                "cloud/apps/api/src/app.ts",
                120,
                "app.get('/v1/chats/legacy', legacyChatsHandler); // keep old clients working",
                "The old route and its handler stay alive with no caller in this repo, so the next schema change has to keep two response shapes in sync.",
                "Could the legacy route and `legacyChatsHandler` be deleted in this PR instead?",
            ),
        ),
        Example(
            good=True,
            why="Linear claim with an exact quote copied from `linear-read PRA-41`.",
            finding=_finding(
                "G.linear-contradiction",
                "cloud/apps/api/src/app.ts",
                64,
                "app.post('/v1/preferences', preferencesHandler);",
                "PRA-41 retires client-facing Vercel routes, so the web app would gain a new dependency on a surface that is scheduled for deletion.",
                "Would a Convex mutation fit here, as the issue describes?",
                confidence="medium",
                linear_issue="PRA-41",
                linear_quote="No client-facing route stays on Vercel.",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: file length is decided by `check:rules`, and the Linear claim has no quote.",
            finding=_finding(
                "R3.file-length",
                "cloud/apps/api/src/service.ts",
                1,
                "export class ApiService {",
                "This file is too long and PRA-13 probably wants it split.",
                "Split the file.",
            ),
        ),
    ),
    "conciseness": (
        Example(
            good=True,
            why="A wrapper with one caller that adds nothing; offered as an option.",
            finding=_finding(
                "G.dead-code",
                "cloud/apps/api/src/features/tools/registry.ts",
                57,
                "export function getToolByName(name: string) { return findTool(name); }",
                "Readers must open two functions to learn that this is a rename; the only caller is `execution.ts`.",
                "Could the caller use `findTool` directly?",
                confidence="medium",
            ),
        ),
        Example(
            good=True,
            why="Same logic added twice in one PR.",
            finding=_finding(
                "G.duplicate-logic",
                "cloud/apps/web/src/lib/format.ts",
                30,
                "const trimmed = value.trim().slice(0, TITLE_MAX);",
                "The same trim-and-cut is also added in `cloud/apps/web/src/chat/title.ts`, so a change to the limit rule has to be made twice.",
                "Would one shared helper work for both call sites?",
                confidence="medium",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: comment wording is decided by `comment-sweep`, not by you.",
            finding=_finding(
                "G.dead-code",
                "cloud/apps/api/src/app.ts",
                10,
                "// This function creates the app and returns it",
                "The comment narrates the code.",
                "Delete the comment.",
            ),
        ),
    ),
    "logic_bs": (
        Example(
            good=True,
            why="Concrete input and wrong outcome, traced in the code.",
            finding=_finding(
                "CORRECTNESS",
                "cloud/packages/sync/src/merge.ts",
                73,
                "if (remote.revision > local.revision) return remote;",
                "When both sides have revision 4 with different content, the local edit wins silently and the remote edit is lost.",
                "Should equal revisions go through the conflict path?",
            ),
        ),
        Example(
            good=True,
            why="A timer used to hide an ordering problem.",
            finding=_finding(
                "R3.root-cause",
                "cloud/apps/web/src/chat/scroll.ts",
                19,
                "setTimeout(() => list.scrollTo({ top: list.scrollHeight }), 50);",
                "On a slow device layout takes longer than 50 ms, so the scroll runs before the new row exists and the chat stays one message short.",
                "Could this run after the row is committed (layout effect) instead of after a delay?",
                confidence="medium",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: a guess (\"might\"), no input that triggers it, and a type error is the typecheck gate's job.",
            finding=_finding(
                "CORRECTNESS",
                "cloud/apps/api/src/service.ts",
                200,
                "const run = await this.store.get(id);",
                "This might be undefined and might cause a type error somewhere.",
                "Add more checks.",
                confidence="medium",
            ),
        ),
    ),
    "security": (
        Example(
            good=True,
            why="Owner id taken from the request body in a public route.",
            finding=_finding(
                "R5.owner-from-auth",
                "cloud/apps/api/src/features/media/routes.ts",
                33,
                "const { userId, fileId } = await c.req.json();",
                "Any signed-in user can send another user's id in the body and read that user's file.",
                "Take the owner from the verified session (`session(c).userId`) and drop it from the body.",
            ),
        ),
        Example(
            good=True,
            why="A secret reaches a log line.",
            finding=_finding(
                "R5.secret-leak",
                "cloud/apps/api/src/features/openrouter/exchange.ts",
                58,
                "jsonLog('openrouter.exchange', { status, key: result.key });",
                "The user's OpenRouter key is written to the log drain in clear text on every successful connect.",
                "Log only the status and the key's last four characters, or nothing.",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: `child_process` is decided by `check:rules`, and the line is not part of this PR's diff.",
            finding=_finding(
                "R5.banned-primitives",
                "cloud/apps/api/src/legacy/run.ts",
                4,
                "import { spawn } from 'node:child_process';",
                "Shell execution is dangerous in general.",
                "Remove it.",
            ),
        ),
    ),
    "hands_on": (
        Example(
            good=True,
            why="Observed in a real run and tied to a changed line.",
            finding=_finding(
                "CORRECTNESS",
                "cloud/apps/web/src/settings/OpenRouterCard.tsx",
                47,
                "onClick={() => connect(redirectUri)}",
                "Clicking Connect in headless Chromium gave `TypeError: redirectUri is undefined` in the console and the page did not navigate.",
                "Could `redirectUri` be read from the callback constant before the handler runs?",
            ),
        ),
        Example(
            good=False,
            why="REJECTED: nothing was run, so nothing was observed.",
            finding=_finding(
                "CORRECTNESS",
                "cloud/apps/web/src/settings/OpenRouterCard.tsx",
                47,
                "onClick={() => connect(redirectUri)}",
                "The button probably does not work on mobile.",
                "Test it on mobile.",
                confidence="medium",
            ),
        ),
    ),
}
