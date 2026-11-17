# Praxis Cloud protocol v1

Client-reviewed contract for web and Swift. Authoritative schemas and exported types: `src/index.ts`. JSON everywhere. Every resource, request, response and event payload has a string `type`. IDs are opaque strings except SSE event sequences, positive safe JSON integers. Dates are ISO-8601 UTC strings (`2026-10-29T14:00:00.000Z`). Swift should ignore unknown optional fields, and skip unknown events while advancing the event cursor. Additive changes are permitted; breaking changes require both client leads' acknowledgment.

API prefix `/v1`. Errors: `{type:"error",code,message,requestId?,details?}`. Missing authentication: 401; row outside session owner: 404; invalid input: 400; unresolved/racing operation: 409; consent missing: 403; unconfigured integration: 503. DELETE returns `{type:"ok"}`. PATCH requires the declared input discriminator, never a generic arbitrary document.

## Sessions

Production API authentication uses a server-verified session: web sends an HttpOnly Secure SameSite cookie (`credentials: include`); iOS sends `Authorization: Bearer <token>`. Neither client accesses Convex directly. `POST /v1/auth/sign-up` and `/v1/auth/sign-in` accept `auth.input` (email,password,name?). Return `session`, including bearerToken only in this direct session response. `GET /v1/auth/session` returns the session without its token. `POST /v1/auth/sign-out` revokes it. The chosen production auth integration is described in ARCHITECTURE.md.

Local only: `POST /v1/auth/dev` accepts `{type:"auth.dev",userId?:string}` and returns a session. Or set `Authorization: Bearer dev-local` (seed user `local-user`). This path and token are disabled outside local mode and production cannot select local adapters. Default local origin `http://localhost:8787`. PORT is overridable; no account or keys needed.

## Bootstrap and local replicas

`GET /v1/bootstrap` returns `bootstrap`: protocolVersion,user,chats,modelKey?,modelPreferences,connectors,skills,activeRuns,syncCursor,syncRoot,serverTime. Latest 50 chats and first model page only; paginate for the rest. Clients paint their saved replica first. `GET /v1/events` is a user-level resumable SSE stream of `user.event` envelopes (entity,entityId,operation,value?,syncCursor). On a change, reconcile the affected row or sync. Disconnections do not cancel runs.

## Chats, messages and runs

- `GET /v1/chats?cursor=&limit=50&q=` → `page<chat>`.
- `POST /v1/chats` (`chat.input`) → `chat` (201).
- `GET /v1/chats/:id` → `chat`. `PATCH` (`chat.patch`) → `chat`. `DELETE` → `ok` and sync tombstone. Deleting a chat cancels its run.
- `GET /v1/chats/:id/messages?cursor=&limit=50` → `page<message>` in chronological order. The transcript is append-only. Tools and system prompt are frozen on first run in `chat.setup`.
- `POST /v1/runs` (`run.start`) → `run` (202). Required chatId, optional text,modelId,mode,effort,attachmentIds,webSearch. Supply `idempotencyKey` or `clientTurnId` for safe retry; same user/chat/key returns the original run without duplicating the message, a changed body is 409. One active run per chat. Local `script` selects text/tools/approval/nestedApproval/elicitation/error/long/compaction/vision; ignored or rejected in production.
- `GET /v1/runs/:id` → `run`. Active bootstrap entries have the same descriptor with id,chatId,status,lastEventId,createdAt,updatedAt,outcome?,error?. Terminal status is completed/cancelled/failed; completed may carry truncated/maxIterations/refused outcome.
- `GET /v1/runs/:id/events` → SSE. `Last-Event-ID: 23` or `?after=23` resumes strictly after that ID. Header wins. SSE `id: 24`, `event: run.event`, `data: <run.event JSON>`. JSON envelope contains id,runId,chatId,createdAt,event. IDs increase monotonically per run and are preserved across reconnects and continuations. Deduplicate by runId + id. Replay includes terminal event then closes; active stream sends keepalives. Retention exhaustion returns 409 `cursor_expired`, requiring a snapshot refetch. No end-of-stream token in JSON.
- `POST /v1/runs/:id/cancel` (`{type:"run.cancel"}`) → `run` (202). Cancellation is durable; tested between provider chunks/tool boundaries. Approvals/elicitation are cancelled with the run.
- `POST /v1/runs/:id/approvals` (`approval.decision`, approvalId,decision allowOnce/allowAlways/deny) → `run` (202). Duplicate identical decisions succeed, conflicting stale decisions return 409. Nested approvals carry parentCallId. Parked work consumes no waiting function.
- `POST /v1/runs/:id/elicitations` (`elicitation.response`,elicitationId,action accept/decline/cancel,content?) → `run` (202).
- `GET /v1/runs/:id/outputs/:outputId` → `{type:"tool.output",id,text,offset,nextOffset}` scoped to this run/chat/user; supports offset/limit for spilled output.

Events cover iteration.started; text.delta/finished; reasoning.delta/finished; tool.started/arguments.delta/ready/running/progress/finished; approval.requested/resolved; elicitation.requested/resolved; attempt.discarded; retrying; usage; compaction; context.measured; messages.committed; policy.updated; vision.activity; run.started/parked/finished. See exact schema. `tool.finished.completion` carries summary,preview,status,content?,outputRef?. Compaction produces a request-time summary, preserving original messages. Provider-native raw payload lives on committed assistant messages for replay, including reasoning signatures.

## Model key and models (OpenRouter)

OpenRouter is the only model provider. Each user connects their own key; connecting it is the consent. The key is sealed server-side and is never returned, logged or put in an event.

- `GET /v1/model-key` → `modelKey` (maskedKey = last 4 characters, label?, connectedAt, lastError?, limit?, limitRemaining?; null limit = no limit) or 404 `not_found`.
- `POST /v1/model-key` → `modelKey`. Body is `{method:"paste",apiKey}` or `{method:"pkce",code,codeVerifier}` (optional `type:"modelKey.connect"`). The server validates a pasted key against OpenRouter's key info, or exchanges the PKCE code. 400 `model_key_rejected` carries OpenRouter's message; 502 `openrouter_unavailable` when OpenRouter can't be reached.
- `POST /v1/model-key/check` → `modelKey` with refreshed label, limit and limitRemaining. A key OpenRouter no longer accepts comes back with `lastError` set (still 200).
- `DELETE /v1/model-key` → ok.
- PKCE (web): send the user to `https://openrouter.ai/auth?callback_url=<https callback>&code_challenge=<S256>&code_challenge_method=S256`, then post the returned `code` with the verifier. OpenRouter accepts only https callbacks (and localhost); no custom schemes.
- PKCE (iOS): open `ASWebAuthenticationSession` (scheme `praxis-app`) at the same OpenRouter URL with `callback_url=https://<web>/settings/openrouter/app-callback`. That page needs no session and redirects to `praxis-app://openrouter/callback?code=<code>`, or `?error=missing_code|invalid_code`. The app then posts the code with its own verifier as above. Codes match `OpenRouterAuthCodeSchema` (1–2000 chars).
- `GET /v1/models?q=&cursor=&limit=50&pinned=&favorite=` → page<`catalogModel` + pinned,favorite,recommended>. The shared OpenRouter catalogue (cached 1 h; the last good copy is served if a refresh fails; 503 `catalog_unavailable` only when there has never been one). `q` searches id and name. Entries: id,name,contextLength,maxOutput?,pricing{prompt,completion} (USD per token, strings),capabilities{tools,reasoning,images}. Order: pinned, then `RECOMMENDED_MODELS`, then name.
- `PATCH /v1/models/preferences` (`model.preference`,modelId,pinned?,favorite?) → `modelPreference` (modelId,pinned,favorite).
- Runs: `run.start` takes `modelId` (a catalogue id; `DEFAULT_MODEL_ID` when absent). With no key `POST /v1/runs` fails with 400 `model_key_missing`. A chosen model that left the catalogue falls back to the default and `run.note` says so. A run that OpenRouter stops ends `failed` with `run.errorCode` and `run.finished.code`: `model_key_invalid` (401; the key record gets `lastError`), `model_credit_exhausted` (402) or `model_key_missing`. `usage.cost` (USD, summed over the run) comes from OpenRouter's usage accounting.
- There is no `providerId` anywhere: chat, run.start and vision preferences name a model by its catalogue id only. Unknown fields sent by older clients are dropped.

## Connectors, consent and skills

- `GET /v1/connectors` → page<connector>. POST connector.input → connector (201). GET/PATCH/DELETE `/v1/connectors/:id`; PATCH connector.patch. Remote HTTP/S only; stdio/process configs rejected. Tokens are encrypted, never returned. Create (and PATCH of url/transport/credentials, and `POST /v1/connectors/:id/refresh` with `{}`) runs an MCP initialize + tools/list handshake (≤ 8 s) and returns the connector with `status` = connected | unreachable | needs_auth | needs_reauth | error, `lastCheckedAt`, `statusCode` (machine reason). Creation succeeds whatever the status; only `connected` means a handshake worked. Clients show `status` (absent = never checked), not `authStatus` alone. Unavailable connectors' tools are not offered; the turn gets a note explaining why.
- `GET /v1/connectors/:id/tools` → page<tool.spec>. `PATCH /v1/connectors/:id/tools/:name` (`{type:"connector.tool",enabled:boolean}`) → connector. Disabling a frozen tool refuses execution; it does not change the frozen catalog.
- `POST /v1/connectors/:id/oauth/start` (`{type:"oauth.start",returnUrl?:string}`) → `{type:"oauth.authorization",url,state}`. `GET /v1/connectors/oauth/callback?code=&state=` completes PKCE. Hosted CIMD `/v1/oauth/client-metadata.json`. Tokens stay server-side.
- `GET /v1/connectors/:id/resources` / `prompts` → page; POST `/resources/read` with `{type:"mcp.resource.read",uri}`; POST `/prompts/get` with `{type:"mcp.prompt.get",name,arguments?}`.
- `GET /v1/consents` → page<consent>; `POST /v1/consents` consent → consent. Per-host consent required before sending AI data. Turning a connector off for a chat uses chat.patch.disabledConnectorIds.
- `GET /v1/skills` → page<skill>. POST skill.input; GET/PATCH/DELETE `/v1/skills/:id` (PATCH skill.input); script execution omitted. Frozen catalog updates apply next conversation.
- `GET/POST /v1/skill-registries`, GET/PATCH/DELETE `/v1/skill-registries/:id` (skill.registry.input). `GET /:id/search?q=&cursor=&limit=`; `POST /:id/install` `{type:"skill.install",skillId}`. Registry documents use SKILL.md. Agent authoring routes through tool policy.

## Files, voice and sync

- `POST /v1/uploads` upload.request (size ≤ 25 MB) → `{type:"upload.url",uploadUrl,method?,expiresAt}`. Send the raw bytes with `Content-Type` = the requested mediaType using `method ?? 'PUT'`; the response JSON carries `storageId`. Production returns a one-time owner-bound Convex HTTP upload URL with `method:"POST"` (a different origin: never send the API bearer token there); local dev returns an API URL with PUT. `POST /v1/uploads/complete` upload.complete (same name/mediaType/size/chatId plus that storageId) → attachment; the Convex upload handler binds storageId to the ticket owner before returning it; completion checks that owner and the exact stored size/type. The upload capability expires after 10 minutes; never share its URL. `GET /v1/uploads/:id` → attachment; DELETE → ok.
- `POST /v1/transcribe` multipart `file` and optional `model`, `language` → transcription with text,language?,segments. Groq key remains on server. Local mode uses deterministic transcription.
- `GET /v1/sync/root` → `{type:"sync.root",root,cursor,strategy}`. `POST /v1/sync/pull` sync.request → sync.response (entities, tombstones, cursor,nextCursor,root,nodes). `POST /v1/sync/tree` same request with strategy merkle and prefixes. `/v1/sync/push` accepts `{type:"sync.push",mutations:[{type:"sync.mutation",entity,operation,value,baseHash?}]}` and routes through the same validated API mutations; unsupported mutations return 400, conflicts 409. Cursor sync is the initial default until measured experiment chooses. `packages/sync` implements canonical portable hashes and replica reconciliation.

## Pagination and versioning

Lists are `{type:"page",items:[...],nextCursor:string|null}`. Cursors are opaque strings and scoped to the user, endpoint and filters. limit 1..100 (sync 1..1000). Missing cursor starts at the first page. Polling snapshots never resets the event cursor. Authentication, bootstrap and provider keys are never put into SSE URLs. Web may use fetch-based streaming for bearer/Last-Event-ID, iOS URLSession bytes; cookie EventSource supports the query after cursor.

## v1 client review additions

Runs and committed messages persist optional clientTurnId. Elicitation accepts mode form|url, url and connectorName. `GET /v1/runs/:id/snapshot` returns authoritative run.snapshot: run,lastEventId,blocks (text/reasoning),tools with activity/argumentsJson/progress/completion,pendingApprovals,pendingElicitations,usage?,messages. Use it on cursor_expired and resume SSE after snapshot.lastEventId. `GET /v1/preferences` returns preferences, `PATCH` accepts preferences.input for vision provider/model and voice model/language/write-only key. Keys remain masked/configured only. OAuth authorization, upload URL/receipt, model probe, registry entry and MCP resource/prompt DTOs have exported schemas.

v1 also adds chat.pinned (default false), optional model tagline/speed/intelligence/supportsImages (null/absent = unknown), provider.defaultModel/headerNames (values never returned), connector error/toolCount/promptsCount/hasNewTools/headerNames, and optional bootstrap consents/registries/preferences. Both clients use preferences.vision for Image Reader and preferences.voice.model for voice model selection.

OAuth native returnUrl is exactly `praxis-app://oauth/callback`; callback redirects include the original oauth.authorization.state on both success and error (plus optional error), after the server consumes state exactly once and stores tokens. iOS validates scheme/host/path/state then GET connector for authStatus. Web return origins are allowlisted. Empty preferences.voice.language selects Auto (clears a prior explicit language). /transcribe accepts optional multipart prompt for split-audio tail continuity. Connector v1 installation is CRUD + tools discovery; remote config import/connector registry additions will be documented as their implementation lands.

Connector `authStatus:"required"` represents needs-reauth; `error:"needs_reauth"` identifies revoked OAuth credentials. Calls stop until connector sign-in succeeds; refresh failures never downgrade an OAuth connector to anonymous MCP.

## Internal turn worker

`POST /api/turn` uses `TurnRequestSchema` and `TurnResultSchema`. Convex signs
the raw body and Unix-millisecond timestamp with HMAC-SHA256; session credentials
are not accepted. See `cloud/DEPLOY.md` for canonical signing and replay rules.

The request carries signed `userId`, `chatId`, `runId`,
`expectedTurnIndex` and an optional structured approval/elicitation decision.
Results carry `turnIndex`, `done`, `status` and `subagents` (unique addressed
child IDs using PRA-79 `SubagentIdSchema` and
`SUBAGENT_LIMITS.CHILDREN_MAX`, currently four). Status is ready/busy while active
and stopped/completed/failed
when terminal, matching the one-turn harness flags. `failed` carries a `TurnFailureSchema`
(`model_key_invalid` / `model_credit_exhausted`, a message and remediation capped at
`TURN_FAILURE_MESSAGE_MAX_BYTES` / `TURN_FAILURE_REMEDIATION_MAX_BYTES` of serialized UTF-8, so a
failed result with every other field at its maximum still fits `TURN_RESULT_MAX_BYTES`). Child lifecycle/handoffs use
PRA-79's durable subagent protocol; this response never embeds handoffs or messages.
The runtime adapter is supplied by PRA-39; absent configuration returns 503.
