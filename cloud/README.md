# Praxis Cloud

Node >=22 (Vercel: Node 24), npm >=11. Everything runs without accounts or keys in local mode.

```sh
cd cloud
npm install
npm run dev:local
```

The API listens on `http://127.0.0.1:8787`. From `cloud/apps/api`, the same `npm run dev:local` command works. Each team starts its own instance from its worktree:

```sh
PORT=8797 npm run dev:local # B, from cloud/ or cloud/apps/api
PORT=8807 npm run dev:local # C
```

Use `Authorization: Bearer dev-local`, or POST `/v1/auth/dev` with `{"type":"auth.dev"}` to receive a cookie and bearer token. For user isolation, include optional `userId` in that request. Dev auth and in-memory adapters cannot start with NODE_ENV=production or on Vercel. State is intentionally lost when the local process exits. No production adapter silently falls back to memory.

Read `packages/protocol/PROTOCOL.md` for routes and exact Zod types in `packages/protocol/src/index.ts`. Dates are ISO-8601 UTC, resource IDs opaque strings, run events monotonic integers. Bootstrap contains seed chat `welcome`, provider `scripted`, two models, vision/voice preferences and active runs.

```sh
curl -s http://127.0.0.1:8787/v1/bootstrap -H 'Authorization: Bearer dev-local'
curl -s http://127.0.0.1:8787/v1/runs -H 'Authorization: Bearer dev-local' \
  -H 'Content-Type: application/json' \
  -d '{"type":"run.start","chatId":"welcome","clientTurnId":"first-turn","text":"Hello","script":"text"}'
# Use the returned run id:
curl -N http://127.0.0.1:8787/v1/runs/RUN_ID/events -H 'Authorization: Bearer dev-local'
# Reconnect strictly after an event:
curl -N http://127.0.0.1:8787/v1/runs/RUN_ID/events \
  -H 'Authorization: Bearer dev-local' -H 'Last-Event-ID: 3'
```

Local scenarios selected by run.start.script: `text`, `tools`, `approval`, `nestedApproval`, `elicitation` (form), `elicitationURL` (protocol v1 `mode:"url"` elicitation with `url`, `connectorId`, `connectorName`; respond accept/decline/cancel without content), `error`, `long`, `compaction`, `vision`. Long streams are paced so Stop/reconnect can be exercised. Compaction requires earlier history to summarize. Approvals and elicitation park in serializable checkpoints; POST their decisions to resume. Disconnection never cancels the producer. Poll `/v1/runs/:id/snapshot` for authoritative partial blocks, tools and pending requests. Send clientTurnId or idempotencyKey on run creation to avoid duplicate turns after a network retry. Cancel uses POST with `{"type":"run.cancel"}`.

Local M1 provides run/chat/message/provider/model/consent/preferences APIs, bootstrap, user SSE, run SSE and snapshots. MCP, skills, JS, uploads, voice, sync and production adapters land as M2/M3 feature modules; unavailable features must return explicit errors, never pretend to execute remote work.

Checks from `cloud/`:

```sh
npm run -ws --if-present typecheck
npm test
```

The test suite includes pure loop/policy/compaction/cancellation checks, auth/ownership/key redaction, idempotent runs, drop/reconnect SSE, authoritative snapshots and actual scripted runtime API flows. External-service contract tests are environment-gated. See `ARCHITECTURE.md`, `docs/api/AGENT.md` and `DEPLOY.md` (production setup and credentials).
