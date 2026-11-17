# Deploying the Praxis API

## Deploy in 3 commands

Run these yourself after creating the hosted projects and filling the private file:

```sh
cp deploy.env.example .env.deploy
node scripts/preflight.mjs && node scripts/deploy.mjs --dry-run
node scripts/deploy.mjs && node scripts/smoke-remote.mjs https://YOUR_API https://YOUR_WEB
```

Run from `cloud/`. The first command creates an empty template: edit `.env.deploy` privately before command 2. It is gitignored. Agents run **dry-run only** with an empty test env; no hosted services or credentials are used. The owner alone runs command 3. Projects must already exist with the API root `cloud/apps/api`, “include files outside root” enabled, and the listed canonical domains configured. Vercel env updates use `--force`. CLI output is suppressed to prevent secret diagnostics; failures identify the command and exit code only.

**What uploads.** The API is deployed from `.deploy/api/`, staged from an allowlist (`cloud/{package.json,package-lock.json,tsconfig.base.json}`, `cloud/apps/api`, `cloud/apps/web/package.json`, `cloud/packages`) with `node_modules`, builds, tests and every `.env*` except `.env.example` excluded, plus a `.vercelignore`. The web is deployed `--prebuilt` from `.deploy/web/`. Before any upload (also in `--dry-run`) the script fails if a staged path is a secret file (`.env*`, `*.pem`/`*.key`/`*.p8`/`*.p12`), lies under `PraxisChat/` or `.deploy/`, or if any staged file contains a configured `*TOKEN*`/`*KEY*`/`*SECRET*` value. It prints per-directory counts and writes the full lists to `.deploy/api-upload.txt` and `.deploy/web-upload.txt`.

`preflight` lists variable names and format errors, never values. It offers `openssl rand -base64 32` for private encryption-key generation. `deploy --dry-run --env /path/to/empty` prints the full masked plan and executes only local API/web builds with a scrubbed environment. Missing deploy config does not prevent that rehearsal. No Vercel/Convex CLI, account creation, env upload or deploy runs in dry mode.

Deploy-only inputs: `VERCEL_TOKEN`, `VERCEL_ORG_ID` (`team_…`/`user_…`), `VERCEL_API_PROJECT_ID`, `VERCEL_WEB_PROJECT_ID` (`prj_…`), `CONVEX_DEPLOY_KEY`. Runtime inputs follow below. **How secrets are passed** (no secret is ever a command-line argument):
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`: environment of the Vercel CLI steps only.
- `CONVEX_DEPLOY_KEY`: environment of the Convex CLI steps only.
- `PRAXIS_CONVEX_SERVER_TOKEN`: a 0600 file in a fresh 0700 temp directory, passed as `--from-file` to `convex env set`, removed afterwards, including on failure, SIGINT and SIGTERM (a SIGKILL cannot be intercepted).
- Vercel runtime env values: stdin of `vercel env add`.
- Build steps get a scrubbed environment (PATH, TMPDIR, `VITE_API_BASE_URL`); only `VITE_API_BASE_URL` reaches the browser build.

The Vercel CLI is pinned (`npx --yes vercel@65.9.0`, see `VERCEL_CLI` in `scripts/deploy.mjs`); the Convex CLI is the locked local dependency (`npx --no-install convex`). Install dependencies first (`npm ci`).

Smoke uses a throwaway user and `DELETE /v1/account` in a `finally` block, including on failure. It exercises email auth on hosted APIs, upload/download, app shell and the actual service-worker bypass control flow. A real paid LLM request requires explicit `--with-llm` plus `SMOKE_LLM_KEY`, `SMOKE_LLM_BASE_URL`, `SMOKE_LLM_MODEL` and optionally `SMOKE_LLM_FLAVOR` in the private env file. Otherwise production run/SSE are explicitly skipped; no scripted production fallback exists. Optional `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` may be validated by preflight but are never sent to the browser or automatically turned into a provider.

Local rehearsal: run `PORT=8822 npm run dev:local -w @praxis/api`, build web with `VITE_API_BASE_URL=http://127.0.0.1:8822 npm run build -w @praxis/web`, then `node node_modules/vite/bin/vite.js preview apps/web --host 127.0.0.1 --port 5196 --strictPort`. Run `node scripts/smoke-remote.mjs http://127.0.0.1:8822 http://127.0.0.1:5196 --dry-run`. Local email auth is genuinely unconfigured (503), so smoke reports that skip, tests disposable dev sessions/sign-out instead, and runs a deterministic local SSE transport check. Hosted `--dry-run` performs reads only, with no auth/account mutation. An empty preflight intentionally exits 1.

CLI references: [Vercel env force/stdin](https://vercel.com/docs/cli/env), [Convex deploy](https://docs.convex.dev/cli/reference/deploy).


Local development needs no accounts (see README: `npm run dev:local`). This page is for the owner who creates the hosted services.
Agents never create accounts, deploy or read credentials.

The production composition is `apps/api/src/production.ts`; the Vercel entry is `apps/api/api/index.ts`.
At startup the API checks every required variable. If any are missing or malformed, it exits with one error listing all of them.
It never falls back to memory adapters or dev auth.

## Environment variables (Vercel project → Settings → Environment Variables)

| Variable | Required | What it is / where to get it |
|---|---|---|
| `PRAXIS_API_URL` | yes | Public https origin of the API, no path (e.g. `https://api.example.com`). Used for OAuth callbacks, upload URLs and the QStash callback. |
| `PRAXIS_WEB_ORIGINS` | yes | Comma-separated https origins of the web app (CORS, CSRF and auth trusted origins). |
| `PRAXIS_ENCRYPTION_KEYS` | yes | AES-256-GCM keyring for provider keys, MCP tokens and the voice key: comma-separated base64 32-byte keys, **current first**, then previous ones. Generate a key with `openssl rand -base64 32`. A single legacy `PRAXIS_ENCRYPTION_KEY` is still accepted. See Key rotation. |
| `CLERK_PUBLISHABLE_KEY` | yes | Clerk instance publishable key. |
| `CLERK_SECRET_KEY` | yes | Server-only Clerk key for identity lookup and account deletion. |
| `CLERK_JWT_KEY` | yes | Clerk instance PEM public key for networkless JWT verification. |
| `VITE_CONVEX_URL` | web build | Convex deployment client URL; web sign-in is Convex Auth v2, configured in the Convex deployment (see [Convex Auth v2 web](#convex-auth-v2-web-pra-34)). |
| `CONVEX_URL` | yes | Convex dashboard → deployment → Settings → URL (`https://<name>.convex.cloud`). |
| `PRAXIS_CONVEX_SERVER_TOKEN` | yes | API-to-Convex credential, ≥ 32 chars: `openssl rand -base64 48`. Set the **same value** in the Convex deployment env (below). |
| `UPSTASH_REDIS_REST_URL` | yes | Upstash console → Redis database → REST API → URL. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Same page → REST token (not the read-only one). |
| `QSTASH_TOKEN` | yes | Upstash console → QStash → `QSTASH_TOKEN`. |
| `QSTASH_CURRENT_SIGNING_KEY` | yes | QStash → Signing keys → current. |
| `QSTASH_NEXT_SIGNING_KEY` | yes | QStash → Signing keys → next (needed for key rotation). |
| `PRAXIS_RUN_BUDGET_MS` | no | Time budget per run slice, default `240000`. Keep it under `maxDuration` (300 s) minus about 30 s. |
| `PRAXIS_SYNC_STRATEGY` | no | `cursor` (default) or `merkle`. |
| `GROQ_API_KEY` | no | Server-side fallback for `/v1/transcribe` (console.groq.com → API Keys). Users can also save their own key; it is stored encrypted. More keys: `GROQ_API_KEY_2`, … (see "Numbered siblings" below). |

### Numbered siblings: several keys for one service

A platform-paid key can have siblings from other accounts of the same service: `NAME` is slot 1, then `NAME_2`, `NAME_3`, … **with no gaps**.
Today this applies to `GROQ_API_KEY` (`GROQ_API_KEY_2`, `GROQ_API_KEY_3`, …).

- **To add a key:** set `NAME_n` in the Vercel project, and in the Convex deployment env too if the service is called from Convex, then redeploy. No code change.
  `npm run deploy` forwards only the unsuffixed name from `.env.deploy`, so add the siblings in the dashboards (or with `vercel env add NAME_2 production`).
- **Failover:** calls use the lowest-numbered healthy key. A key that answers 401/403, 402 (or a quota error), 429 or 5xx is put on a cool-down (an hour, an hour, the `Retry-After` time or 60 s, 15 s) and the next one is used.
  Cool-downs live in Upstash Redis under `pool:<service>:<slot>:cooldown` and expire by themselves. If Redis is unreachable, every key is treated as healthy.
- **A gap** (`NAME_2` missing, `NAME_3` set): `NAME_3` is ignored and a `startup.warning` log line names it.
- **A credential made of several variables** forms one slot per suffix (`X_ID` + `X_SECRET`, `X_ID_2` + `X_SECRET_2`). A slot with only some of its variables stops startup.
- Logs and Redis hold slot numbers only, never key values. Users' own keys, `PRAXIS_ENCRYPTION_KEYS` and the QStash signing keys are not pooled and keep their own rotation rules.

Never set these in production: `PRAXIS_LOCAL_SMOKE` (the bundle refuses to start if it is set), `NODE_ENV=development`.
Browser builds get only the API origin, never a secret.

### Convex deployment environment (Convex dashboard → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `PRAXIS_CONVEX_SERVER_TOKEN` | Same value as on Vercel. Every Convex function rejects calls without it. |

## 1. Convex

1. Create a project at dashboard.convex.dev (production deployment).
2. In `cloud/`, run `npx convex deploy`. It asks for login/`CONVEX_DEPLOY_KEY`, and pushes `cloud/convex/` (schema plus the store, auth, files and tools functions).
3. Set `PRAXIS_CONVEX_SERVER_TOKEN` in the Convex env, and copy the deployment URL into `CONVEX_URL` on Vercel.
4. Never ship `CONVEX_DEPLOY_KEY` to the API or clients. It is only for the deploy step.

## 2. Upstash

1. Create a **Redis** database (regional, close to the Vercel region; TLS on). Copy the REST URL and token.
   Event streams keep the last 5000 events per run for 7 days; reconnects older than that get `cursor_expired`, and clients then refetch the run snapshot.
2. Open **QStash** in the same account. Copy `QSTASH_TOKEN` and both signing keys.
   The API publishes continuations to `PRAXIS_API_URL/internal/continue` with 3 retries. Each delivery is signature-checked, and duplicate deliveries are fenced by the run lease and compare-and-set checkpoint writes.

## 3. Vercel (API)

1. Create a project from this repo with Root Directory `cloud/apps/api`. Enable "Include files outside the root directory" (npm workspaces).
2. Framework: Other. `vercel.json` sets install (`cd ../.. && npm ci`), build (`npm run build`), Fluid compute, `maxDuration` 300 s, 1024 MB memory, and routes every path to `api/index.ts`.
3. Node.js version: 24.x. Add the variables above to Production (and Preview, with separate Convex and Upstash resources if possible).
4. Deploy. Check `GET /health` → `{"mode":"production"}`.
5. Native dependencies: `sharp` (image crop) and `quickjs-emscripten` (JS sandbox) stay external and are installed by `npm ci` on Vercel.

## 4. Vercel (web)

Create a second project with Root Directory `cloud/apps/web` (see `cloud/docs/web/`). Set its API origin to `PRAXIS_API_URL`, and add its origin to `PRAXIS_WEB_ORIGINS`.

## OAuth and callback URLs to register

| What | URL |
|---|---|
| MCP connector OAuth redirect (register with servers that need a pre-registered client; DCR clients get it automatically) | `PRAXIS_API_URL/v1/connectors/oauth/callback` |
| Hosted client metadata document (CIMD client id) | `PRAXIS_API_URL/v1/oauth/client-metadata.json` |
| Native app return after connector OAuth (handled by the app, nothing to register server-side) | `praxis-app://oauth/callback?state=…` |
| Web return after connector OAuth | an origin listed in `PRAXIS_WEB_ORIGINS` |
| QStash continuation (no registration; it must be publicly reachable) | `PRAXIS_API_URL/internal/continue` |
| Google sign-in redirect (Convex Auth v2) | `<CONVEX_SITE_URL>/oauth/google/callback` |
| Apple sign-in return URL (Convex Auth v2, public HTTPS) | `<CONVEX_SITE_URL>/oauth/apple/callback` |

## Security notes

- OpenRouter calls (a pinned URL, never user input), MCP servers, registry URLs and the JS `fetch` bridge all go through one SSRF guard (`adapters/security.ts`). It allows http(s) only, resolves DNS once and dials that pinned address, blocks private, loopback, link-local and metadata ranges, and limits redirects.
- Request logs are JSON lines with request id, method, path, status and duration. They never include query strings, headers, cookies, bodies or provider responses.
- Rate limits use an Upstash sliding window, 120 requests per minute per verified user, plus a per-IP bucket on public paths. Over the limit, the API answers 429 with `Retry-After`.
- QStash signing keys: rotate them in QStash, then update both values.

## Key rotation (`PRAXIS_ENCRYPTION_KEYS`)

Every ciphertext names its key (`v2.<kid>…`, where kid is a hash prefix of the key), so several keys can be live at once.
1. Generate a new key: `openssl rand -base64 32`.
2. Prepend it: `PRAXIS_ENCRYPTION_KEYS=<new>,<old>`. Redeploy. New writes use `<new>`; old values still decrypt with `<old>`.
3. Re-seal stored secrets, from `cloud/apps/api`:
   `PRAXIS_ENCRYPTION_KEYS=<new>,<old> CONVEX_URL=… PRAXIS_CONVEX_SERVER_TOKEN=… npx tsx scripts/reencrypt.ts --dry-run`, then run it again without `--dry-run`.
   It prints counts only (owners, rows, rewritten, failed) and exits 1 if any value couldn't be opened. Re-running it is safe.
4. When `failed` is 0, wait at least 10 minutes (pending OAuth state in Redis is sealed too), then remove `<old>` and redeploy.
Never drop a key before step 3 reports `failed: 0`: values sealed only with that key would become unreadable.

## Verifying a build without deploying

```
cd cloud && npm ci && npm run -ws --if-present typecheck && npm test
cd apps/api && npm run build                      # esbuild bundle → dist/index.mjs (~5.4 MB)
PORT=8789 node scripts/serve-bundle.mjs &         # bundled handler on memory adapters (local only)
npm --prefix ../.. run verify -- api --api http://127.0.0.1:8789   # bootstrap → SSE → approval → cancel → replay
```
`npx vercel build` needs a Vercel login or token (`login_required` without one), so it was not run by agents.
Live Convex and Upstash contract tests run when their env vars are set: `CONVEX_URL` + `PRAXIS_CONVEX_SERVER_TOKEN`, and `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.


## Account deletion protocol (additive)

Production uses Clerk JWT bearer sessions. `DELETE /v1/account` requires a first-factor authentication less than five minutes old (`fva`); sign out and sign in again if necessary. The Clerk user is deleted through the backend interface after data purge and before the final auth batch; see the documented interrupted-deletion recovery limitation. Local development/legacy test adapters: `DELETE /v1/account` accepts `{ "type": "account.delete", "password": "…" }` (password optional only for a session created less than five minutes ago). Authentication and the normal origin/CSRF checks apply. Success returns `{ "type": "account.deleted" }`, clears the local cookie, and invalidates all credentials. Repeating erasure is harmless; replaying revoked credentials returns 401. Missing confirmation returns 403. Deletion attempts have a dedicated five/hour limit in addition to the normal authenticated limit; both still apply after deletion begins. Rate-limit counters are a single self-expiring key per limit under a SHA-256 key name, are never owner-indexed, and are not erased: they expire within their window (at most one hour).

The production eraser locks account activation, marks the account as deleting, freezes owner Redis writes, purges indexed Redis data (streams, caches, OAuth state and leases), then hard-deletes every owner-scoped Convex table and uploaded blobs in bounded batches. The caller’s session and credential survive until the final atomic auth deletion, so interrupted deletion can retry. Redis ownership indexes are registered atomically with writes as a sorted set scored by key expiry, pruned on every owner write so it stays bounded; the purge removes keys in chunks and drops them from the index as it goes, so a retry resumes. Activation verifies that the Convex account remains active. The global blob sweep stores its cursor on the user row, so a retried request continues it. Generic Convex writes are fenced once deletion begins. Blob ownership tags also permit deleting interrupted, unbound uploads. New data tables must be included in `convex/account.ts`; new owner KV writes must carry `ownerId` (feature contexts do so automatically).

No hosted deletion, provider call, deployment, or credential access was performed by the implementation worker. Local tests use a fake Clerk interface and locally signed JWTs, plus legacy Better Auth migration/conformance fixtures. No hosted account is created. See `docs/WP-H1-AUTH-SYNC.md` for migration, conflict rules and the native client requirements.


## CI

GitHub Actions runs Node 22 / npm 11 typecheck, unit tests, web/API builds,
comment sweep, and the production high-severity npm audit as parallel checks
on `blacksmith-4vcpu-ubuntu-2404`. The comment job also runs `check:rules`
when `cloud/scripts/check-rules.mjs` exists. Modal reviewer pytest uses the
same runner and the locked Python 3.12 environment without calling Modal.
Apple changes run the iOS Simulator build, `PraxisChatTests`, and every Swift
package's tests on GitHub-hosted `macos-26`; UI tests are outside this check.
The iOS job ad-hoc signs the simulator app so real Keychain tests retain their
entitlements without a developer certificate. It builds once for testing and
runs unit tests serially on one prebooted simulator, uploading `.xcresult`
bundles on failure. Workflow changes also trigger their own checks. All jobs have timeouts,
read-only repository permissions, pinned actions and cancellation of older runs.

SonarCloud scans `wapo-org_praxis` in organization `wapo-org` on Blacksmith.
In SonarCloud, open the project → Administration → Analysis Method and disable
Automatic Analysis. Generate an analysis token under My Account → Security;
in GitHub Settings → Secrets and variables → Actions add repository secret
`SONAR_TOKEN`. Missing credentials fail explicitly. The scan publishes the gate
without waiting for it: configure a new-code-only “Clean as You Code” gate under
Quality Gates, baseline `develop`, then set `sonar.qualitygate.wait=true` once
that gate passes. Coverage is omitted because no Vitest coverage provider is
installed; adding dependencies is outside this change.

The web e2e suite is omitted: it requires externally started servers, includes
headed 120 Hz/display-specific probes and explicit browser skips, and writes
worker-specific design captures. It has no deterministic headless CI contract.
The cloud unit suite currently contains live Convex/Upstash/storage tests and a
local MiniLM-cache probe that skip without their prerequisites. CI rejects a
nonzero skipped/todo count rather than reporting that suite as fully passing.
These tests need a separate explicit live-service contract before this check
can be required; no tests are disabled by these workflows.

Owner setup: install/enable the Blacksmith GitHub App for this repository;
grant the pushing fine-grained PAT repository **Workflows: read and write**.
After all checks pass, GitHub Settings → Rules → Rulesets (or Branches → branch
protection) for `develop` and `main`: require `Cloud / typecheck`, `Cloud / tests`,
`Cloud / web-build`, `Cloud / api-build`, `Cloud / comments`, and `Cloud / audit`.
Do not require path-filtered Apple/Modal checks globally: unrelated PRs never
create them. Require `SonarCloud / scan` only after the token and analysis method
are configured; require the SonarCloud quality-gate check only after the new-code
gate is green. There is no merge or deployment step in CI.


## Convex Auth v2 web (PRA-34)

Install with `cd cloud && npm install`, then run `CONVEX_AGENT_MODE=anonymous npx convex dev` for local development.
Set deployment variables with `npx convex env set NAME` (enter secret values interactively):
`RESEND_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`, `SITE_URL`,
`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`,
`AUTH_APPLE_CLIENT_ID`, `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, `AUTH_APPLE_PRIVATE_KEY`.
All are required; use a Resend-verified sender and the actual web origin for SITE_URL.
Set web `VITE_CONVEX_URL` to the deployment's client URL; no provider credentials belong in Vite.
For the local API, set `PRAXIS_LOCAL_CONVEX_URL` to the same loopback HTTP deployment:
`PRAXIS_LOCAL_CONVEX_URL=http://127.0.0.1:3210 npm run dev:local`.
Without this API variable, the legacy local API accepts dev tokens rather than Convex sessions.
The managed browser verification stack sets both URLs automatically; the local API variable is not a production setting.
Register the Google redirect URI and Apple Services ID return URL listed under [OAuth and callback URLs](#oauth-and-callback-urls-to-register).
The HTTPS page for the future iOS handoff must share the SITE_URL origin.
No cloud deployment is part of PRA-34 verification.
Component tests use the upstream fake Resend component, retaining the real password WASM and auth code.
Run them with `npx vitest run tests/auth-v2.test.ts`.
### Internal turn caller (PRA-38)

Set `PRAXIS_TURN_CURRENT_SIGNING_KEY` to a random secret of at least 32 characters,
shared only by Convex server actions and the Vercel worker. Optionally set
`PRAXIS_TURN_NEXT_SIGNING_KEY` (same minimum length) during rotation. Both keys
verify; switch the caller before promoting the next key. These are signing keys,
not HTTP provider credential pools.

Convex sends `POST /api/turn` with `x-praxis-timestamp` containing canonical Unix
milliseconds and `x-praxis-signature` containing lowercase SHA-256 HMAC hex over
the exact UTF-8 timestamp, a dot, and the raw request bytes. Skew is limited to
±5 minutes. The signed body binds `userId`; the Convex caller must derive that
owner from its verified auth/workflow context. A browser cookie or bearer session
cannot authorize this route. The streamed raw body limit is 1,000,000 bytes.

The worker atomically records a hashed envelope receipt through
`AdapterBundle.store.putIfRevision` in Convex. Exact replay returns 401 across
instances and signing-key rotation. Retries must use a fresh timestamp/signature
while preserving `expectedTurnIndex`; durable turn acquisition/commit makes
those retries idempotent. Receipt rows contain only expiry, not credentials;
a future retention sweep may remove them only after `expiresAtMs`.

PRA-38 supplies the contract and authentication boundary. Until PRA-39 supplies
`AdapterBundle.turn.execute`, an authenticated request returns 503. Never
replace that with a successful dummy result. Execution must validate owner/chat/run
relationships against durable state and return only flags and addressed child IDs;
verified subagent handoffs and message content remain in durable state.
