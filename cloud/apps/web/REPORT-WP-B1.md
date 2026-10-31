# WP-B1 handoff

- Removed invented connector/tool/skill/registry/provider-test/sync/upload/transcription success paths and seed-model placeholders. Missing routes propagate a `Not available: <route>` error; existing screen error handling displays it.
- Added cookie-session verification, email sign-in, sign-out and 401 routing to sign-in, including SSE and same-origin uploads. Dev login requires both Vite DEV and API local mode; production output excludes its button.
- IDB is keyed by API origin and verified user, checks persisted identity, wipes on switch/sign-out, removes legacy IDB/localStorage, and rejects writes from a previous store session. No chat/message data is written to localStorage.
- SSE validates RunEventSchema, drops unknown events with a development warning, and supports CRLF framing.
- Defined all missing custom properties (scan across web/glass: zero undefined references). Header fits 402 px; model lists exclude pinned/favorite entries in both All Models branches and count/virtualization threshold.
- Scripts in `scripts/` cover findings 1–5, real same-browser account switching, real IDB isolation, six screenshots, and measured authenticated replica mount times. See PERF.md.

## Limitations / external follow-up

- Referenced `PraxisChat/PraxisChat/DesignSystem/Paper.swift` does not exist in this checkout or the main repository on disk. Tokens use existing web palette aliases and review-specified #2F7A4D; exact iOS token verification remains open.
- Historical `cloud/docs/web/PERF.md` is outside owned paths; left unchanged. `apps/web/PERF.md` explicitly supersedes its unsubstantiated numbers and documents what was measured.
- No absent route found in the currently module-enabled API. Core-only test fixture lacks connectors/skills routes; tests now require their explicit 404 instead of fakes. Actual email sign-in against production auth was not exercised; component tests verify the request contract.
- Existing API on 8817 belongs to another worktree; reused and left running. A 30-tool-run + snapshot probe stayed healthy; original long-run crash not reproduced. This is bounded smoke coverage, not a long soak.
- No dependencies added. npm install reported four high-severity vulnerabilities; dependency remediation is outside this package. Production build retains a >500 kB chunk warning.
- Push-only branch; do not merge before reviewer approval.
