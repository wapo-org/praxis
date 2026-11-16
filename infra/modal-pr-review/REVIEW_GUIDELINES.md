# Praxis PR Review Guidelines

Automated PR reviews run inside Modal Sandboxes across **6 specialized `muse-ember-1.0` (`max` reasoning effort) sessions** plus live `cloud/` verification.

## Core Review Posture (Non-Opinionated & Collaborative)

- **Ask and offer rather than dictate.** Because the review model is smaller than frontier implementation models, frame architectural, abstraction, refactoring, and conciseness suggestions as questions or options (`"Could we extract..."`, `"Consider whether..."`, `"Would it help to...?"`), not commands (`"You must..."`, `"Always..."`).
- **Verify against Linear (`PRA-*`).** Every review session has read-only access to Linear team `PRA` (via the `linear` MCP server and `/usr/local/bin/linear-read`). Check the linked/matching `PRA-*` issue(s) to confirm acceptance criteria, scope, and architectural invariants (`PRA-72`–`PRA-81`) before flagging design choices.
- **Check across files.** Trace callers, sibling adapters, shared schemas (`@praxis/protocol`), and Web/iOS parity (`@praxis/glass` ↔ `Tokens.swift`) beyond the raw diff lines.
- **Ground every finding in evidence.** Only report issues verified in files read, cross-file traces, Linear specs, or observed tool/test output. Cite exact `path:line`, Linear issue IDs, or failing command output.
- **Only block (`REQUEST_CHANGES`) on objective failures:**
  - Security or tenant-isolation vulnerabilities, secret leakage, or SSRF/egress bypasses.
  - Broken logic, race conditions, or runtime/typecheck/test/Playwright failures.
  - Violations of explicit **HARD boundaries** in `AGENTS.md` or direct contradictions of a Linear `PRA-*` spec.
  - Use `COMMENT` for questions, offers, abstraction ideas, and conciseness suggestions.

## Specialized Review Sessions & Assigned Skills

All skills from `cursor/plugins/pstack/skills` are installed under `/root/.config/muse/skills/`. Each session MUST read its assigned `SKILL.md` files before reviewing:

1. **`abstractions` — Layer Boundaries, Plug-and-Play Modularity & Constants**
   - Skills: `principle-boundary-discipline`, `principle-model-the-domain`, `principle-type-system-discipline`, `principle-foundational-thinking`, `typescript-best-practices`, `architect`
   - Checks: protocol-first schemas (`@praxis/protocol`), pure port isolation (`@praxis/agent`), `AdapterBundle`/`FeatureModule`/`@praxis/credentials` seams, pluggable/unpluggable module boundaries, and moving scattered static strings, routes, keys, timeouts, limits, and design tokens into named constants in the owning layer.
2. **`maintainability` — Long-Term Maintenance, Blast Radius & Clean Break**
   - Skills: `blast-radius`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-make-operations-idempotent`, `how`, `why`
   - Checks: cross-file/cross-client blast radius (`cloud/` + `PraxisChat/`), file size (~400-line cap), single-line compression hurting readability, deleting obsolete shims/docs (`PRA-73`) in the same PR, idempotent retries/checkpoints, and alignment with Linear `PRA-*` tasks.
3. **`conciseness` — Code Conciseness, Subtraction & Comment Hygiene**
   - Skills: `no-comments`, `principle-subtract-before-you-add`, `principle-minimize-reader-load`, `unslop`
   - Checks: unnecessary wrappers/indirections, verbose or repetitive code that can be expressed more concisely, dead code, narrating comments (`comment-sweep.mjs`), AI-slop prose, and stray `.md` files. *(Reports findings as offers; does not edit files or spawn subagents.)*
4. **`logic_bs` — Logic, Efficiency, Root Causes & Bullshit Detection**
   - Skills: `principle-fix-root-causes`, `principle-attack-the-premise`, `principle-explain-the-number`, `principle-prove-it-works`, `interrogate`
   - Checks: symptom/band-aid fixes (`setTimeout` hacks, duplicate guards), inefficient I/O or Convex budget bloat (`PRA-80`), split-brain state, unjustified magic numbers, unverified claims, and mismatches with Linear task requirements.
5. **`security` — Security, Isolation, Taint & Secrets**
   - Skills: `principle-boundary-discipline`, `principle-type-system-discipline`, `blast-radius`, `principle-fix-root-causes`, `interrogate`
   - Checks: auth/session-derived `userId` (`PRA-35`), secret redaction (`SealedSecret`, logs, URLs, Redis keys), SSRF egress validation, banned execution primitives (`child_process`, `eval`, `new Function`, `vm`, `worker_threads` in `apps/api`), inner-action tool classification & taint propagation (`PRA-76`), and fail-closed production adapters.
6. **`hands_on` — Live App Verification**
   - Skills: `principle-prove-it-works`, `principle-fix-root-causes`
   - Checks: `npm --prefix cloud run typecheck`, `npm --prefix cloud test`, `node cloud/scripts/comment-sweep.mjs check`, live `cloud/` API (`:8797`) + Vite web (`:5173`), `smoke:local`, `p0-check.mjs`, and an ad-hoc Playwright Chromium script testing the PR's changed user flows.
