# Praxis PR Review Guidelines

Automated PR reviews run in disposable podman containers on the reviewer host (`praxis-review.service`). Five code sessions run on `gpt-6.2-sol` (low effort) and the optional UI check on `muse-ember-1.0` (medium), so the design assumes a model will sometimes be wrong: **scripts decide everything that can be decided mechanically, and the server deletes every model finding it cannot verify.**

## Who decides what

1. **Deterministic gates — run by the server, never judged by a model.**
   `npm --prefix cloud run typecheck`, `npm --prefix cloud test`, `npm --prefix cloud run check:rules` (compared against the merge-base baseline, so a PR cannot pass by growing its own baseline) and `node cloud/scripts/comment-sweep.mjs check`. `check:rules` lines are posted verbatim.
2. **Five read-only model sessions, one narrow job each**, plus one `hands_on` session that boots the app. A session may only cite the rule ids in its own checklist, returns at most 5 findings, and is told to say nothing when unsure.
3. **Server-side validation.** A finding is posted only if all of this holds; otherwise it is dropped and the reason is logged:
   - `rule_id` is on the closed list below, is a judgement rule, and belongs to that session;
   - `file` and `line` are in the PR diff, and `evidence` is found verbatim in that file's diff (whitespace-insensitive);
   - `confidence` is `high` or `medium`;
   - a Linear claim carries a `linear_quote` that appears in the issue text the server fetches itself;
   - it does not duplicate another finding (same file, same rule, within 3 lines).

## Review posture (collaborative, non-opinionated)

- **Ask and offer rather than dictate.** Suggestions are phrased as questions or options (`"Could we…?"`, `"Would it help to…?"`), never orders.
- **Ground every finding in evidence:** an exact quote of the changed line and a concrete failure scenario (input → wrong outcome). No "might", no general advice.
- **Blocking (`REQUEST_CHANGES`) happens only when** a deterministic gate fails, or a **HARD** rule finding with verified evidence has `high` confidence. Everything else is a `COMMENT`. The reviewer never approves.
- A session with missing or malformed output contributes no public finding. Session diagnostics stay in the private run log.

## Oracle review output and development media

- Code findings are attached to changed lines when GitHub accepts the anchor. Unplaced findings and verified gate failures are posted as individual comments. Clean runs are recorded privately.
- A code session sets `ui_check` only when a change needs manual UI verification that tests cannot guarantee. Then the server signs in to the PR's Vercel preview as the test account (unrecorded), Muse drives the requested check through `review-check` (recorded), ffmpeg turns the recording into a contact sheet, and a Sol session reports only a 0–10 UI/UX score and concrete visual inconsistencies.
- A preview or test-account access request names the access needed. Supply credentials through the private reviewer configuration.
- Videos and contact sheets are kept in the reviewer’s private Oracle storage. To retrieve one over SSH, run `sudo -n -u praxis-review python3 /opt/praxis-review/scripts/read-review-artifact.py RUN_ID development.webm` on Oracle and redirect stdout to a file on the client. The other supported asset is `contact-sheet.png`.

## Rule ids (closed list)

Script-owned ids are the `[R…]` tags in [`AGENTS.md`](../../AGENTS.md) plus `GATE.typecheck`, `GATE.test`, `GATE.check-rules` and `GATE.comment-sweep`; a model finding that cites one is dropped. Judgement ids:

| Rule id | Kind | Session | Meaning |
| --- | --- | --- | --- |
| `R1.single-shape` | HARD | abstractions | API/event shape declared outside `@praxis/protocol`, or twice |
| `R1.api-thin-routes` | HARD | abstractions | Route handler bypasses `AdapterBundle`, or a new public Hono route / `FeatureModule` (PRA-13, PRA-41) |
| `R1.client-policy-dup` | HARD | abstractions | Client re-implements server policy or secret logic |
| `R2.shared-constant` | advisory | abstractions | Cross-layer value (error code, route, header, key prefix, timeout, limit) written inline; UI copy is exempt |
| `R2.unit-suffix` | advisory | abstractions | Numeric limit/timeout constant without a unit in its name |
| `R3.readable-functions` | advisory | maintainability | New or touched function compressed into multi-statement lines |
| `R3.root-cause` | advisory | logic_bs | Timer race, swallowed error, or fallback hiding an upstream bug |
| `R3.fail-closed` | HARD | security | Production path degrades instead of failing (exceptions: PRA-61 cooldowns, PRA-59 catalogue) |
| `R4.boundary-parse` | HARD | abstractions | Untrusted input cast or trusted without a Zod / `Codable` parse |
| `R4.illegal-states` | advisory | abstractions | Optional-field bag where a discriminated union fits |
| `R4.adhoc-brand` | advisory | abstractions | Ad-hoc `TenantId` / `SealedSecret` instead of the ones in `@praxis/types` |
| `R5.owner-from-auth` | HARD | security | Owner id taken from client input instead of verified auth |
| `R5.secret-leak` | HARD | security | Secret reaches a log, response, URL, Redis key or telemetry |
| `R5.ssrf-egress` | HARD | security | User/model URL fetched without the SSRF-guarded `egress` fetch |
| `R5.taint` | HARD | security | Inner tool action unclassified, or taint not propagated |
| `G.clean-break` | advisory | maintainability | Compatibility shim, un-migrated caller, or docs made false by the PR |
| `G.plan-docs` | advisory | maintainability | Plan/summary `.md` file committed at the repo root |
| `G.dead-code` | advisory | conciseness | New code with no caller, or a pass-through wrapper |
| `G.duplicate-logic` | advisory | conciseness | Same logic added twice, or a copy of an existing helper |
| `G.unproven-claim` | advisory | logic_bs | PR description claims something the diff does not do |
| `G.linear-contradiction` | advisory | maintainability | Changed line contradicts the linked `PRA-*` issue (needs a verified quote) |
| `CORRECTNESS` | advisory | logic_bs, hands_on | A concrete input gives a wrong result |
| `SECURITY` | advisory | security | Another concrete, exploitable weakness |

`rules.py` mirrors this table and `tests/test_rules.py` fails when they drift.

## Seeing slop

- Every run is written to `/var/lib/praxis-review/runs` on the reviewer host (never to GitHub): per session the raw model output, parsed findings, kept findings, dropped findings with the reason, timings and step/token counts; plus gate results and the final verdict.
- `evals/` holds fixture diffs with seeded issues and clean diffs. `python evals/harness.py` scores recorded outputs offline.
