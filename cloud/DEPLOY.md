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

Set these under **Settings → Environment Variables** on the named Vercel project. Add distinct Preview and Production values. Deployments get new values on the next build. [Vercel environment scopes](https://vercel.com/docs/environment-variables#environments)

### Web project

| Variable | Preview | Production |
|---|---|---|
| `VITE_CONVEX_URL` | URL of the test Convex deployment | URL of the production Convex deployment |
| `VITE_API_BASE_URL` | HTTPS origin of the staging API | HTTPS origin of the production API |
| `VITE_CLERK_PUBLISHABLE_KEY` | Optional legacy Account Settings display flag | Optional legacy Account Settings display flag |

The current web sign-in provider is Convex Auth v2. Vite embeds `VITE_*` values in browser bundles. Supply the first two variables at build time. The existing local prebuilt uploader passes `VITE_API_BASE_URL` but currently omits `VITE_CONVEX_URL`, so use the Vercel Git build for this setup or fix that uploader before using it for hosted sign-in.

### API project

| Variable | Preview | Production |
|---|---|---|
| `PRAXIS_API_URL` | Stable staging API HTTPS origin, without a path | Canonical production API HTTPS origin, without a path |
| `PRAXIS_WEB_ORIGINS` | Comma-separated exact HTTPS origins of the permitted test web deployments | Comma-separated exact HTTPS origins of the permitted production web domains |
| `PRAXIS_ENCRYPTION_KEYS` | Independent staging AES keyring | Production AES keyring. Each key is 32 random bytes, base64 encoded, current first |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` | Clerk test instance, including the PEM JWT public key | Clerk production instance. The API startup validator still requires all three |
| `CONVEX_URL` | Test Convex deployment client URL | Production Convex deployment client URL |
| `PRAXIS_CONVEX_SERVER_TOKEN` | Random 32+ character token matching test Convex | Separate random 32+ character token matching production Convex |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Test Redis database and read/write REST token | Production Redis database and read/write REST token |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Test QStash credentials and signing keys | Production QStash credentials and signing keys |
| `PRAXIS_TURN_CURRENT_SIGNING_KEY` | Random 32+ character test HMAC key | Separate random 32+ character production HMAC key |
| `PRAXIS_TURN_NEXT_SIGNING_KEY` | Optional during a turn-key rotation | Optional during a turn-key rotation |

The preview web build should use test data end to end. The reviewer opens the exact deployment URL for the PR commit, so the preview API must allow **that origin** in `PRAXIS_WEB_ORIGINS` for browser API calls. Configure the appropriate `SITE_URL` and OAuth return URLs in test Convex for authenticated preview flows. Use a staging API origin reachable by the browser and QStash. The web preview's Vercel automation cookie is scoped to its own host, and QStash needs to reach the API's signature-checked continuation endpoint independently. [Vercel Preview URLs](https://vercel.com/docs/deployments/environments) · [Deployment Protection](https://vercel.com/docs/deployment-protection)

Optional on the API project in either scope:

- `GROQ_API_KEY` for platform transcription. Set `GROQ_API_KEY_2` and later slots if testing or using failover. [PRA-69](https://linear.app/praxis-a/issue/PRA-69/live-check-pra-61-credential-pool-on-real-groq-keys-and-upstash)
- `EXA_API_KEY` and `FIRECRAWL_API_KEY` for built-in search and reading. They also support contiguous numbered slots. Each test user needs a Convex platform allowance record for paid calls. [PRA-60](https://linear.app/praxis-a/issue/PRA-60/exa-firecrawl-built-in-web-search-and-reading)
- `PRAXIS_EMBEDDER=openai` and `PRAXIS_OPENAI_EMBEDDINGS_KEY` for the current OpenAI embeddings path. Leave both unset to keep hosted embeddings off.
- `PRAXIS_RUN_BUDGET_MS` and `PRAXIS_SYNC_STRATEGY` for explicit overrides. The current defaults are `240000` and `cursor`.

### Convex, Modal and deploy tooling

- **Convex test and production:** set the matching `PRAXIS_CONVEX_SERVER_TOKEN`. For sign-in set `SITE_URL`, `RESEND_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_APPLE_CLIENT_ID`, `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, and `AUTH_APPLE_PRIVATE_KEY`. Put the matching turn HMAC keys in Convex when the signed caller is enabled. [PRA-111](https://linear.app/praxis-a/issue/PRA-111/live-check-pra-34-web-sign-in-google-apple-and-resend) · [PRA-113](https://linear.app/praxis-a/issue/PRA-113/live-check-pra-38-convex-to-vercel-signed-turn-caller)
- **Modal secret `praxis-pr-reviewer-vercel`:** `VERCEL_WEB_PROJECT_ID`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` when required, and `VERCEL_AUTOMATION_BYPASS_SECRET` for a protected preview. Generate that last value under the Vercel web project's Deployment Protection settings. The GitHub video attachment uses the existing Modal `GITHUB_TOKEN` with push access. [Reviewer setup](../infra/modal-pr-review/README.md#vercel-preview-setup)
- **Local deploy tooling:** `VERCEL_ORG_ID`, `VERCEL_API_PROJECT_ID`, `VERCEL_WEB_PROJECT_ID`, `VERCEL_TOKEN`, and `CONVEX_DEPLOY_KEY` are CLI inputs. The local deploy template still asks for `BETTER_AUTH_SECRET`, which the current Vercel runtime does not require. The current runtime also requires Clerk and the turn HMAC key even though the older deploy preflight does not list them.

### Upcoming Linear work

| Work | What to prepare | Where and when |
|---|---|---|
| Stateless turn worker | Keep `PRAXIS_TURN_CURRENT_SIGNING_KEY` and reserve `PRAXIS_TURN_NEXT_SIGNING_KEY` for rotation | Match the corresponding Convex deployment when the real caller lands. The current worker validates signatures, and actual turn execution depends on PRA-39. [PRA-38](https://linear.app/praxis-a/issue/PRA-38/turn-worker-14-authenticated-apiturn-endpoint-and-contract) · [PRA-39](https://linear.app/praxis-a/issue/PRA-39/turn-worker-24-hydrate-run-one-turn-write-back) |
| Workflow and API migration | Plan to remove `QSTASH_*` and retire web `VITE_API_BASE_URL` once their callers have migrated | Keep them in both scopes while the public Hono API and QStash continuation are in use. Redis stays for cache and credential cooldowns. Recheck the Clerk keys and other legacy API settings against the worker startup validator at cutover. [PRA-27](https://linear.app/praxis-a/issue/PRA-27/convex-core-45-crons-and-webhook-receiver) · [PRA-41](https://linear.app/praxis-a/issue/PRA-41/turn-worker-44-retire-the-public-hono-surface) · [PRA-18](https://linear.app/praxis-a/issue/PRA-18/upstash-redis-turn-and-session-cache) |
| App sandboxes | Separate Modal token ID and token secret pairs for staging and production. Pool tests use `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` with paired suffixes | Put the credentials on the server boundary that creates the app sandboxes once wired. [PRA-19](https://linear.app/praxis-a/issue/PRA-19/modal-sandboxes-modalimage-modalvolume-encrypted-ports) · [PRA-52](https://linear.app/praxis-a/issue/PRA-52/modal-25-lifecycle-ownership-and-the-sandboxes-table) |
| Tenant identities | One stable HMAC secret per environment. The ticket does not name the variable | Share between Vercel worker and Convex within one environment. Keep staging and production distinct. [PRA-36](https://linear.app/praxis-a/issue/PRA-36/auth-35-one-tenant-id-for-all-six-boundaries) |
| Connectors, memory and telemetry | Composio server API credential, `SUPERMEMORY_API_KEY`, and a PostHog project credential | Add as each integration ships, on the owning server. PRA-47 calls for API environment validation and a signature-verified Convex webhook. The exact Composio and PostHog variable names and scopes are pending implementation. [PRA-47](https://linear.app/praxis-a/issue/PRA-47/composio-14-entities-connect-links-and-the-connections-table) · [PRA-17](https://linear.app/praxis-a/issue/PRA-17/supermemory-long-term-memory-user-profiles-and-hybrid-search) · [PRA-23](https://linear.app/praxis-a/issue/PRA-23/posthog-posthogai-posthog-node) |
| Model access | User-managed OpenRouter credentials | Product settings store per-user keys. OpenRouter does not require a shared Vercel key for the planned BYOK path. [PRA-59](https://linear.app/praxis-a/issue/PRA-59/openrouter-bring-your-own-model-key) |

### Numbered siblings: several keys for one service

A platform-paid key can have siblings from other accounts of the same service: `NAME` is slot 1, then `NAME_2`, `NAME_3`, … **with no gaps**.
Today this applies to `GROQ_API_KEY`, `EXA_API_KEY`, and `FIRECRAWL_API_KEY`.

- **To add a key:** set `NAME_n` in the Vercel project, and in the Convex deployment env too if the service is called from Convex, then redeploy. No code change.
  `npm run deploy` forwards only the unsuffixed name from `.env.deploy`, so add the siblings in the dashboards (or with `vercel env add NAME_2 production`).
- **Failover:** calls use the lowest-numbered healthy key. A key that answers 401/403, 402 (or a quota error), 429 or 5xx is put on a cool-down (an hour, an hour, the `Retry-After` time or 60 s, 15 s) and the next one is used.
  Cool-downs live in Upstash Redis under `pool:<service>:<slot>:cooldown` and expire by themselves. If Redis is unreachable, every key is treated as healthy.
- **A gap** (`NAME_2` missing, `NAME_3` set): `NAME_3` is ignored and a `startup.warning` log line names it.
- **A credential made of several variables** forms one slot per suffix (`X_ID` + `X_SECRET`, `X_ID_2` + `X_SECRET_2`). A slot with only some of its variables stops startup.
- Logs and Redis hold slot numbers only, never key values. Users' own keys, `PRAXIS_ENCRYPTION_KEYS` and the QStash signing keys are not pooled and keep their own rotation rules.

Never set these in production: `PRAXIS_LOCAL_SMOKE` (the bundle refuses to start if it is set), `NODE_ENV=development`.
Browser builds receive the public service URLs listed above.

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

The production eraser locks account activation, marks the account as deleting, freezes owner Redis writes, purges indexed Redis data (streams, caches, OAuth state and leases), then hard-deletes every owner-scoped Convex table and uploaded blobs in bounded batches. The caller’s session and credential survive until the final atomic auth deletion, so interrupted deletion can retry. Redis ownership indexes are registered atomically with writes as a sorted set scored by key expiry, pruned on every owner write so it stays bounded; the purge removes keys in chunks and drops them from the index as it goes, so a retry resumes. Activation verifies that the Convex account remains active. The global blob sweep stores its cursor on the user row, so a retried request continues it. Generic Convex writes are fenced once deletion begins. Blob ownership tags also permit deleting interrupted, unbound uploads. Every Convex table must declare a deletion policy in `convex/accountTables.ts` (a missing one fails typecheck); in-flight workflows are cancelled and their journals cleaned before their runs are deleted; new owner KV writes must carry `ownerId` (feature contexts do so automatically).

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

### Built-in web search and reading (PRA-60)

Configure `EXA_API_KEY` and `FIRECRAWL_API_KEY` in the API environment. Both support
contiguous `_2`, `_3`, … siblings through `@praxis/credentials`; cooldowns use Upstash.
Missing keys return a structured unavailable result and never use a development key.
Deploy the `convex/webTools.ts` actions and internal mutations alongside the API.

PRA-22 must provision an owner-scoped `toolState` row with kind `platformAllowance`,
id equal to the UTC billing month (`YYYY-MM`), and value `{allowanceMicroUsd: integer}`.
No row means no paid admission. PRA-102 determines the amount; this feature supplies
no default allowance or unauthenticated allowance setter. Usage rows have kind
`platformUsage` and contain payer, provider service, serving slot and micro-USD cost.
PRA-22 reconciliation must settle or release interrupted `webAccounting` reservations
and preserve `webSpendCall` receipts across the retry horizon.

The thin turn worker must include `webToolClassifier` when composing its trusted
classification registry; external-egress retains PRA-76 approval requirements.
The account deletion sweep already purges owner `toolState` and output records.
Verify real search, scrape, credential failover, Upstash TTL and usage settlement in
the `Live check: PRA-60` sub-issue before moving the parent to Done.
