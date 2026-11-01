# Deploying the Praxis API

## Deploy in 3 commands

Run these yourself after creating the hosted projects and filling the private file:

```sh
cp deploy.env.example .env.deploy
node scripts/preflight.mjs && node scripts/deploy.mjs --dry-run
node scripts/deploy.mjs && node scripts/smoke-remote.mjs https://YOUR_API https://YOUR_WEB
```

Run from `cloud/`. The first command creates an empty template: edit `.env.deploy` privately before command 2. It is gitignored. Agents run **dry-run only** with an empty test env; no hosted services or credentials are used. The owner alone runs command 3. Projects must already exist with the API root `cloud/apps/api`, “include files outside root” enabled, and the listed canonical domains configured. Vercel env updates use `--force`; static web output is staged in ignored `.deploy/`. CLI output is suppressed to prevent secret diagnostics; failures identify the command and exit code only.

`preflight` lists variable names and format errors, never values. It offers `openssl rand -base64 32` for private encryption-key generation. `deploy --dry-run --env /path/to/empty` prints the full masked plan and executes only local API/web builds with a scrubbed environment. Missing deploy config does not prevent that rehearsal. No Vercel/Convex CLI, account creation, env upload or deploy runs in dry mode.

Deploy-only inputs: `VERCEL_TOKEN`, `VERCEL_ORG_ID` (`team_…`/`user_…`), `VERCEL_API_PROJECT_ID`, `VERCEL_WEB_PROJECT_ID` (`prj_…`), `CONVEX_DEPLOY_KEY`. Runtime inputs follow below. The Convex server token is set from a private temporary file and deleted afterwards; Vercel runtime env values go through stdin, never argv. Only `VITE_API_BASE_URL` is exposed to the browser build. Install dependencies first (`npm ci`); the owner’s remote commands require the Vercel CLI and Convex CLI through npx.

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
| `BETTER_AUTH_SECRET` | yes | Session signing secret, ≥ 32 chars: `openssl rand -base64 48`. |
| `PRAXIS_COOKIE_SAMESITE` | no | `lax` (default), `strict` or `none`. Use `none` when the web app and API are on different sites. |
| `CONVEX_URL` | yes | Convex dashboard → deployment → Settings → URL (`https://<name>.convex.cloud`). |
| `PRAXIS_CONVEX_SERVER_TOKEN` | yes | API-to-Convex credential, ≥ 32 chars: `openssl rand -base64 48`. Set the **same value** in the Convex deployment env (below). |
| `UPSTASH_REDIS_REST_URL` | yes | Upstash console → Redis database → REST API → URL. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Same page → REST token (not the read-only one). |
| `QSTASH_TOKEN` | yes | Upstash console → QStash → `QSTASH_TOKEN`. |
| `QSTASH_CURRENT_SIGNING_KEY` | yes | QStash → Signing keys → current. |
| `QSTASH_NEXT_SIGNING_KEY` | yes | QStash → Signing keys → next (needed for key rotation). |
| `PRAXIS_RUN_BUDGET_MS` | no | Time budget per run slice, default `240000`. Keep it under `maxDuration` (300 s) minus about 30 s. |
| `PRAXIS_SYNC_STRATEGY` | no | `cursor` (default, the winner of docs/SYNC_EXPERIMENT.md) or `merkle`. |
| `GROQ_API_KEY` | no | Server-side fallback for `/v1/transcribe` (console.groq.com → API Keys). Users can also save their own key; it is stored encrypted. |

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
| Better Auth (email/session routes) | `PRAXIS_API_URL/v1/auth/*` |

## Security notes

- Provider base URLs, MCP servers, registry URLs and the JS `fetch` bridge all go through one SSRF guard (`adapters/security.ts`). It allows http(s) only, resolves DNS once and dials that pinned address, blocks private, loopback, link-local and metadata ranges, and limits redirects.
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
PORT=8789 node scripts/smoke-local.mjs            # bootstrap → SSE → approval → cancel → resume
```
`npx vercel build` needs a Vercel login or token (`login_required` without one), so it was not run by agents.
Live Convex and Upstash contract tests run when their env vars are set: `CONVEX_URL` + `PRAXIS_CONVEX_SERVER_TOKEN`, and `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.


## Account deletion protocol (additive)

`DELETE /v1/account` accepts `{ "type": "account.delete", "password": "…" }` (password optional only for a session created less than five minutes ago). Authentication and the normal origin/CSRF checks apply. Success returns `{ "type": "account.deleted" }`, clears the local cookie, and invalidates all credentials. Repeating erasure is harmless; replaying revoked credentials returns 401. Missing confirmation returns 403. Deletion attempts have a dedicated five/hour limit in addition to the normal authenticated limit.

The production eraser locks account activation, marks the account as deleting, freezes owner Redis writes, purges indexed Redis data (streams, caches, OAuth state and leases), then hard-deletes every owner-scoped Convex table and uploaded blobs in bounded batches. The caller’s session and credential survive until the final atomic auth deletion, so interrupted deletion can retry. Redis ownership indexes are registered atomically with writes; activation verifies that the Convex account remains active. Generic Convex writes are fenced once deletion begins. Blob ownership tags also permit deleting interrupted, unbound uploads. New data tables must be included in `convex/account.ts`; new owner KV writes must carry `ownerId` (feature contexts do so automatically).

No hosted deletion, provider call, deployment, or credential access was performed by the implementation worker. Local synthetic auth tests exercise sign-up/in/out and deletion against the real Better Auth implementation with in-memory Convex/Redis test adapters; they do not create hosted accounts.
