# @praxis/verify — `praxis-verify`

One entry point for every check an agent or a human runs before saying "it works". Run it from `cloud/`:

```
npm run verify -- <command>          # or: npx praxis-verify <command>
```

| Command | What it does | Exit |
| --- | --- | --- |
| `gate [--only a,b] [--json]` | The AGENTS.md verification list (typecheck, test, check-rules, lint, comment-sweep, web-build, api-build). Runs every step even after a failure; one line per step; logs in `artifacts/gate/<run>/`. | 0 / 1 |
| `web [--flows a,b] [--ports web,api] [--base URL --api URL] [--seed n] [--headed] [--json]` | Starts the local API and web (default ports 5240 and 8860, in-memory store, hash embedder), runs Playwright flows, stops its own process groups. Refuses an occupied port. With `--base`/`--api` it verifies servers someone else started. | 0 / 1 |
| `api [--port n \| --api URL] [--json]` | The local API smoke: bootstrap, models, chat, text SSE, snapshot, nested approval, disconnect + cancel + Last-Event-ID replay. | 0 / 1 |
| `ios [--simulator udid\|name] [--skip-tests] [--json]` | macOS only: uses `--simulator`, or the newest available iPhone simulator that is shut down (never one someone has booted), `xcodebuild build-for-testing` + `test-without-building` for `PraxisChatTests` (as `apple.yml`), installs and launches the app and saves a `simctl` screenshot. Uses the shared-machine `slot.sh` when present. | 0 / 1 |
| `map --check` | `cloud/verify/feature-map.json` against the code, both ways: a mapped flow/check/suite without code fails, and so does code no feature covers. | 0 / 1 |
| `live <suite> [--evidence step=path\|url]… [--only a,b]` / `live --list` | Runs `cloud/verify/live/<suite>.ts` and writes `artifacts/live/<suite>/<run>/proof.json`. | 0 complete, 1 failed, 3 incomplete |

Usage errors exit 2. Artifacts live under `cloud/artifacts/` (gitignored).

## Web flows

Every flow runs in a fresh browser context and gets three files: `<flow>.aria.yml` (accessibility snapshot), `<flow>.png` (full-page screenshot, also on failure) and `<flow>.issues.json`. A flow **fails** on any console error, page error, failed request or 4xx/5xx response that its `allow` list does not name, with a reason. Chrome's console echo of a judged response and `net::ERR_ABORTED` (navigation, cancelled SSE) are not counted.

Default flows: `load-app`, `settings-models`, `model-search`, `scripted-chat`, `api-resilience` (formerly `apps/web/scripts/p0-check.mjs`). Off by default: `fuzz-chat`, a seeded random walk over send / stop / reload / new chat / switch chat that checks the composer stays usable after every step (`--flows fuzz-chat --seed 3`).

Add a flow in `src/web/flows.ts`, then a feature entry that covers it; `map --check` fails until both exist.

## Live suites and `proof.json`

A suite is `export default defineSuite({id, issue, title, steps})` in `cloud/verify/live/<id>.ts`, where `issue` is the `Live check: PRA-n` issue. Each step quotes its checklist line and declares its `needs`:

- `secrets` are read as `SealedSecret` and seeded into the redactor; `config` holds non-secret values (URLs, project ids); `pools` are `@praxis/credentials` pools read with production's `NAME`, `NAME_2`… rules.
- An unmet need **skips** the step with `missing credential X`; it never passes.
- `auto` steps run code; `manual` steps carry an instruction and wait for `--evidence step=<file|url>`.
- Text evidence (manual files and `attach()`ed bytes alike) is redacted before it is written and hashed. Binary evidence is accepted only as image, video or PDF, which a human must check for secrets; any other binary is refused.
- `--only` runs a subset; the remaining steps are recorded as `skipped` with `not selected (--only)`, so a partial run is never `complete`.
- Hosted responses are parsed with the `@praxis/protocol` schemas (`RunSnapshotSchema`, `ErrorSchema`, …): a malformed answer fails the step.
- A step that reads an env value it did not declare fails.

Hosted steps use `PRAXIS_LIVE_API_URL` (https origin) and `PRAXIS_LIVE_TOKEN` (a session bearer of a throwaway live-check account).

`proof.json` (`praxis-verify/proof@1`, zod schema `ProofSchema` exported from this package):

```jsonc
{
  "$schema": "praxis-verify/proof@1",
  "suite": "openrouter", "issue": "PRA-89", "title": "…",
  "runId": "20261116T213000Z-a1b2c3", "startedAt": "…", "finishedAt": "…",
  "git": {"sha": "…", "dirty": false},
  "host": {"platform": "darwin", "node": "v24.…"},
  "status": "complete | incomplete | failed",
  "summary": {"pass": 0, "fail": 0, "skipped": 0, "pending": 0, "attached": 0},
  "steps": [{
    "id": "paste-key", "kind": "auto | manual", "checklist": "…",
    "status": "pass | fail | skipped | pending | attached",
    "summary": "…", "reason": "missing credential OPENROUTER_LIVE_KEY", "instruction": "…",
    "needs": ["PRAXIS_LIVE_TOKEN", "PRAXIS_LIVE_API_URL", "OPENROUTER_LIVE_KEY"],
    "startedAt": "…", "finishedAt": "…",
    "evidence": [{"kind": "file", "path": "evidence/paste-key-model-key.json", "sha256": "…", "bytes": 123}, {"kind": "url", "url": "https://…"}],
    "log": ["POST /v1/model-key → 200"]
  }]
}
```

- `complete`: every step is `pass` or `attached`. `failed`: any `fail`. Otherwise `incomplete`.
- `attached` means a human supplied evidence that someone still has to judge; the guard (PRA-70) should require `complete`, the matching `issue`, a `git.sha` on the merged branch and `dirty: false`, then link the proof from the live-check issue.
- Redaction: declared secrets, pool slots and any env value whose name ends in `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `PAT` are replaced with `[redacted]` in raw, JSON-escaped and URL-encoded form, as are known key shapes (`sk-or-…`, `gsk_…`, GitHub tokens, `Bearer …`). It runs on every log line, summary, text evidence and finally on the serialized proof. `src/live/runner.test.ts` proves a step that logs, attaches, returns and throws its key leaves no trace on disk.
