# Praxis Cloud deployment setup

Local development needs no accounts: see README. Agents do not create projects/accounts, deploy, or read credentials from other apps. The following setup is for the owner to perform after reviewing production readiness.

## Current readiness

M1 local API is executable and tested. Production adapters, real providers/MCP/tools and external-service verification are separate M2/M3 work. A successful local smoke or bundle does not establish production readiness. Production must fail closed if auth, durable scheduling or storage is missing; never select memory adapters or dev auth on Vercel.

## Accounts and services

1. Create/select a Convex deployment. Configure its schema and server-only API functions from `cloud/convex/` once available. Obtain the deployment URL and an internal service credential; do not expose either service credential or deployment admin keys to web/iOS. Attachments and output spills use Convex file storage.
2. Create/select Upstash Redis with sufficient stream retention and QStash. Obtain Redis REST URL/token, QStash publish token, and current/next signing keys. Configure continuation callback to `https://API_HOST/internal/continue`; request signatures and lease fencing are mandatory. Choose retention above the required reconnect window and monitor memory/stream trimming.
3. Create Vercel projects for API (`cloud/apps/api`) and static SPA (`cloud/apps/web`). Set Node 24. API has one Hono Node entry, Fluid Compute and bounded slices. Set build root/install commands for npm workspaces (install from `cloud/`). No agent runs vercel deploy.
4. Configure Better Auth with the API public origin, trusted web origin, Convex-backed auth/session storage and bearer plugin for Swift. Confirm login, logout, cookie flags, session expiry and revocation using both clients before enabling nonlocal users. API-only access applies to all Convex data.
5. Register MCP OAuth redirect `https://API_HOST/v1/connectors/oauth/callback`. Hosted CIMD is `https://API_HOST/v1/oauth/client-metadata.json`. Connector auth uses DCR when allowed; manually provisioned clients may require their own client ID/secret. Native return is exactly `praxis-app://oauth/callback?state=...` (same issued state, success or error), after server-side token exchange. Web return origins must be allowlisted. Never accept arbitrary redirects.

## Environment inventory

| Variable | Purpose | Local requirement |
|---|---|---|
| `NODE_ENV` | production restrictions | unset/development for local |
| `PORT` | local API listener (A 8787, B 8797, C 8807) | optional |
| `HOST` | local bind address (default 127.0.0.1) | optional; use explicit LAN bind for physical device |
| `PRAXIS_API_URL` | public API origin used by callbacks and absolute URLs | production |
| `PRAXIS_ALLOWED_ORIGINS` | comma-separated trusted SPA origins for CORS/CSRF | production |
| `BETTER_AUTH_SECRET` | random high-entropy auth signing secret | production |
| `BETTER_AUTH_URL` | exact public auth/API origin | production |
| `PRAXIS_ENCRYPTION_KEY` | base64 encoding of exactly 32 random bytes, AES-256-GCM | production; local generates ephemeral key |
| `CONVEX_URL` | server deployment endpoint | production/Convex contract tests |
| `CONVEX_DEPLOY_KEY` | Convex CLI provisioning credential (never shipped in API/client) | setup only |
| `PRAXIS_CONVEX_SERVICE_TOKEN` | API-to-Convex authenticated service access | production/contract tests |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint | production/Upstash tests |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token | production/Upstash tests |
| `QSTASH_TOKEN` | publishes bounded continuation jobs | production |
| `QSTASH_CURRENT_SIGNING_KEY` | verifies current QStash signatures | production |
| `QSTASH_NEXT_SIGNING_KEY` | rotating QStash verification key | production |
| `PRAXIS_CONTINUATION_URL` | absolute signed callback destination | production |
| `PRAXIS_RUN_BUDGET_MS` | execution slice budget below Vercel function max duration | production default documented with scheduler |
| `PRAXIS_SYNC_STRATEGY` | cursor or merkle; experiment winner is default | optional |
| `GROQ_API_KEY` | server transcription key fallback; user key stays encrypted | voice integration only |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | optional small live provider smoke tests | never required |
| `PRAXIS_MCP_ALLOWED_RETURN_ORIGINS` | approved web OAuth returns | production OAuth |
| `PRAXIS_OAUTH_CLIENT_ID` / `PRAXIS_OAUTH_CLIENT_SECRET` | connector-specific manual client fallback if supported | service-dependent |

Adapters may name additional test-only options; record their exact implemented variables in docs/api/DATA.md. The inventory above describes required roles; do not claim a variable is wired until its adapter lands. No browser environment variable may contain secrets. Browser configuration is API origin only; Swift stores its session bearer, never Convex/Redis credentials.

## Verification and rollout

Run `npm install`, `npm run -ws --if-present typecheck`, `npm test`, API bundle check, then local `npm run dev:local` and `npm run smoke:local -w @praxis/api`. Real adapter contract suites require the listed environment; skips must be recorded. Test signed continuation beyond a tiny function budget, duplicate callback delivery, lease expiry, provider/tool interruption, output spills, Redis retention expiry/snapshot resume, cache invalidation, user separation, and cookie/bearer logout before production.

A Convex accountless local deployment may be used for tests on ports 3210/3211 without creating a hosted project. Team-specific API ports avoid collisions. Vercel CLI local build may require login/project linkage; if unavailable, use the API's own esbuild step and state that `vercel build` was not verified.

Use HTTPS in production, encrypted secrets with owner/resource authenticated data, approved outbound destinations, small request limits, per-user rate limits, bounded provider streams and QuickJS memory/time limits. Logs must omit request bodies, credentials/cookies, OAuth codes, transcripts and provider responses. Key rotation needs a planned decrypt-and-reencrypt pass and a rollback window; changing PRAXIS_ENCRYPTION_KEY alone makes old values unreadable.
