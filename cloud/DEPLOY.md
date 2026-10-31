# Deploying the Praxis API

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
| `PRAXIS_ENCRYPTION_KEY` | yes | AES-256-GCM key for provider keys, MCP tokens and the voice key. Generate with `openssl rand -base64 32`. Changing it makes stored secrets unreadable. |
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
- Key rotation: rotate the QStash signing keys in QStash, then update both values. `PRAXIS_ENCRYPTION_KEY` rotation needs a decrypt-and-re-encrypt migration (not provided yet).

## Verifying a build without deploying

```
cd cloud && npm ci && npm run -ws --if-present typecheck && npm test
cd apps/api && npm run build                      # esbuild bundle → dist/index.mjs (~5.4 MB)
PORT=8789 node scripts/serve-bundle.mjs &         # bundled handler on memory adapters (local only)
PORT=8789 node scripts/smoke-local.mjs            # bootstrap → SSE → approval → cancel → resume
```
`npx vercel build` needs a Vercel login or token (`login_required` without one), so it was not run by agents.
Live Convex and Upstash contract tests run when their env vars are set: `CONVEX_URL` + `PRAXIS_CONVEX_SERVER_TOKEN`, and `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
