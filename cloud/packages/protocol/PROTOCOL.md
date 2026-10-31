# Praxis Cloud protocol v1

Client-reviewed contract for web and Swift. Authoritative schemas and exported types: `src/index.ts`. JSON everywhere. Every resource, request, response and event payload has a string `type`. IDs are opaque strings except SSE event sequences, positive safe JSON integers. Dates are ISO-8601 UTC strings (`2026-10-29T14:00:00.000Z`). Swift should ignore unknown optional fields, and skip unknown events while advancing the event cursor. Additive changes are permitted; breaking changes require both client leads' acknowledgment.

API prefix `/v1`. Errors: `{type:"error",code,message,requestId?,details?}`. Missing authentication: 401; row outside session owner: 404; invalid input: 400; unresolved/racing operation: 409; consent missing: 403; unconfigured integration: 503. DELETE returns `{type:"ok"}`. PATCH requires the declared input discriminator, never a generic arbitrary document.

## Sessions

Production API authentication uses a server-verified session: web sends an HttpOnly Secure SameSite cookie (`credentials: include`); iOS sends `Authorization: Bearer <token>`. Neither client accesses Convex directly. `POST /v1/auth/sign-up` and `/v1/auth/sign-in` accept `auth.input` (email,password,name?). Return `session`, including bearerToken only in this direct session response. `GET /v1/auth/session` returns the session without its token. `POST /v1/auth/sign-out` revokes it. The chosen production auth integration is described in ARCHITECTURE.md.

Local only: `POST /v1/auth/dev` accepts `{type:"auth.dev",userId?:string}` and returns a session. Or set `Authorization: Bearer dev-local` (seed user `local-user`). This path and token are disabled outside local mode and production cannot select local adapters. Default local origin `http://localhost:8787`. PORT is overridable; no account or keys needed.

## Bootstrap and local replicas

`GET /v1/bootstrap` returns `bootstrap`: protocolVersion,user,chats,providers,models,connectors,skills,activeRuns,syncCursor,syncRoot,serverTime. Latest 50 chats and first model page only; paginate for the rest. Clients paint their saved replica first. `GET /v1/events` is a user-level resumable SSE stream of `user.event` envelopes (entity,entityId,operation,value?,syncCursor). On a change, reconcile the affected row or sync. Disconnections do not cancel runs.

## Chats, messages and runs

- `GET /v1/chats?cursor=&limit=50&q=` → `page<chat>`.
- `POST /v1/chats` (`chat.input`) → `chat` (201).
- `GET /v1/chats/:id` → `chat`. `PATCH` (`chat.patch`) → `chat`. `DELETE` → `ok` and sync tombstone. Deleting a chat cancels its run.
- `GET /v1/chats/:id/messages?cursor=&limit=50` → `page<message>` in chronological order. The transcript is append-only. Tools and system prompt are frozen on first run in `chat.setup`.
- `POST /v1/runs` (`run.start`) → `run` (202). Required chatId, optional text,providerId,modelId,mode,effort,attachmentIds,webSearch. Supply `idempotencyKey` or `clientTurnId` for safe retry; same user/chat/key returns the original run without duplicating the message, a changed body is 409. One active run per chat. Local `script` selects text/tools/approval/nestedApproval/elicitation/error/long/compaction/vision; ignored or rejected in production.
- `GET /v1/runs/:id` → `run`. Active bootstrap entries have the same descriptor with id,chatId,status,lastEventId,createdAt,updatedAt,outcome?,error?. Terminal status is completed/cancelled/failed; completed may carry truncated/maxIterations/refused outcome.
- `GET /v1/runs/:id/events` → SSE. `Last-Event-ID: 23` or `?after=23` resumes strictly after that ID. Header wins. SSE `id: 24`, `event: run.event`, `data: <run.event JSON>`. JSON envelope contains id,runId,chatId,createdAt,event. IDs increase monotonically per run and are preserved across reconnects and continuations. Deduplicate by runId + id. Replay includes terminal event then closes; active stream sends keepalives. Retention exhaustion returns 409 `cursor_expired`, requiring a snapshot refetch. No end-of-stream token in JSON.
- `POST /v1/runs/:id/cancel` (`{type:"run.cancel"}`) → `run` (202). Cancellation is durable; tested between provider chunks/tool boundaries. Approvals/elicitation are cancelled with the run.
- `POST /v1/runs/:id/approvals` (`approval.decision`, approvalId,decision allowOnce/allowAlways/deny) → `run` (202). Duplicate identical decisions succeed, conflicting stale decisions return 409. Nested approvals carry parentCallId. Parked work consumes no waiting function.
- `POST /v1/runs/:id/elicitations` (`elicitation.response`,elicitationId,action accept/decline/cancel,content?) → `run` (202).
- `GET /v1/runs/:id/outputs/:outputId` → `{type:"tool.output",id,text,offset,nextOffset}` scoped to this run/chat/user; supports offset/limit for spilled output.

Events cover iteration.started; text.delta/finished; reasoning.delta/finished; tool.started/arguments.delta/ready/running/progress/finished; approval.requested/resolved; elicitation.requested/resolved; attempt.discarded; retrying; usage; compaction; context.measured; messages.committed; policy.updated; vision.activity; run.started/parked/finished. See exact schema. `tool.finished.completion` carries summary,preview,status,content?,outputRef?. Compaction produces a request-time summary, preserving original messages. Provider-native raw payload lives on committed assistant messages for replay, including reasoning signatures.

## Providers and models

- `GET /v1/providers` → `page<provider>`. `POST` (`provider.input`) → provider. `GET/PATCH/DELETE /v1/providers/:id`. PATCH uses provider.input; apiKey omitted preserves existing key. Secret values are write-only; reads expose maskedKey only. Provider URL + flavor + capabilities determine behavior, not its name.
- `POST /v1/providers/:id/test` (`{type:"provider.test"}`) → `{type:"provider.test.result",ok,models}`. `POST /v1/providers/:id/refresh-models` (`{type:"models.refresh"}`) → page<model>.
- `GET /v1/models?providerId=&q=&cursor=&limit=50&pinned=&favorite=` → page<model>, filtered and searched server-side. Models expose reasoningEfforts (empty = no dial), capability flags, contextWindow?,maxOutputTokens?,pinned,favorite.
- `PATCH /v1/models/preferences` (`model.preference`,providerId,modelId,pinned?,favorite?) → model.

## Connectors, consent and skills

- `GET /v1/connectors` → page<connector>. POST connector.input → connector (201). GET/PATCH/DELETE `/v1/connectors/:id`; PATCH connector.patch. Remote HTTP/S only; stdio/process configs rejected. Tokens are encrypted, never returned.
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
