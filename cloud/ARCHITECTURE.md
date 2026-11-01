# Praxis Cloud architecture

## Components and boundaries

Praxis Cloud is an npm workspace running on Node 24 in Vercel Fluid Compute. `apps/api` uses Hono and one function entry; it validates JSON using `packages/protocol` Zod schemas. Both React and Swift call this API; neither talks directly to Convex or Upstash. The web and iOS apps paint an existing local replica before requesting `/v1/bootstrap` and resumable user change events. Resource IDs are opaque strings, dates ISO-8601 UTC, and events plain discriminated JSON.

`packages/agent` is a platform-independent TypeScript state machine. It imports protocol types but no Vercel, Convex or Upstash modules. Storage, KV, ordered events, clock, fetch, model provider and tools are injected ports. `packages/sync` holds portable canonical serialization and the hash-tree experiment. Convex functions and schema live in `cloud/convex/`; server-side adapter modules live under `apps/api/src/adapters/`. The Swift runtime is read-only reference. Its append-only transcript, mode policy and capability gates remain invariants.

The API selects local in-memory adapters only through a dedicated `dev:local` entry. Production startup refuses local/development authentication even if flags are misconfigured. The scripted provider exercises text, reasoning, tool execution, nested approvals, elicitation, error, compaction, vision activity and long runs with no external service. Production adapters are configured explicitly and never fall back silently to in-memory state.

## Lifecycle and durability

A client creates a chat, then posts a run with a client turn/idempotency key. Creation scopes all lookup keys by user and chat, rejects concurrent active runs, persists the user message and freezes the system prompt, tool specs and skill catalog once. The service schedules execution independently of the SSE reader. Each step loads a checkpoint, verifies ownership and a fenced execution lease, checks the durable cancel flag, then invokes provider or tool ports. Provider chunks emit ordered run events; completed responses and tools checkpoint transcript additions and loop state. Replaying the same flavor preserves opaque provider payloads and reasoning signatures. Request-time transformations handle capabilities, summaries and unsupported images without rewriting history.

Approvals and elicitations persist their pending descriptor and park the run. A response POST validates the pending ID and decision, records it exactly once, and schedules the next step. A parked run holds no function. Nested calls carry parentCallId and traverse the same tool policy as top-level calls. Always-allow grants are keyed by tool schema fingerprint and never override a mode refusal. Cancel is a Redis flag checked between chunks and tool boundaries, and is reflected in the durable checkpoint. A dropped client connection only ends its SSE subscription, never the producer.

**Continuation choice: Upstash QStash.** A signed QStash callback schedules a bounded execution slice before the Vercel duration budget expires. It reuses the Upstash operations stack and permits a simple versioned checkpoint, rather than introducing replay-sensitive workflow code into the pure loop. The API verifies QStash signatures; the callback accepts only a run identifier, never user secrets. At-least-once delivery requires compare-and-set checkpoint versions, fenced leases and idempotent event append. External side-effect tools cannot promise exactly-once remote execution after a crash; their in-flight marker is persisted before invocation, and ambiguous non-idempotent work requires human recovery rather than blind replay. Local continuation uses the same scheduling port with a queued callback and tiny-budget tests. Deployment must not rely on fire-and-forget work after returning a response; production initial work is published durably before 202, and each continuation is scheduled before acknowledging its callback.

Events use one Redis Stream per run. A monotonically increasing numeric sequence is allocated atomically alongside XADD (explicit `<sequence>-0` Redis IDs). JSON and SSE expose that same sequence as the id. A reconnect resumes strictly after Last-Event-ID. The event stream remains the live replay log and the Convex checkpoint is the authoritative durable state; a checkpoint outbox bridges state commits to event publication, with stable IDs so retries deduplicate. Terminal streams replay and close; heartbeats keep active SSE connections alive. Streams have finite retention; a cursor older than retention yields cursor_expired rather than silently losing data. User-level streams announce mutations across devices. Token and cookie values never appear in logs or event URLs.

## Storage, auth and secret handling

Convex tables are scoped by userId, with indexes beginning with userId (or a server-only composite owner key): users, sessions, accounts, verifications for auth; chats; messages; runs/checkpoints; providers; model preferences; connectors and OAuth state; skills/registries; consent; attachments; tool outputs; sync revisions/tombstones and event outbox. Clients cannot call unauthenticated generic mutations. API-to-Convex requests authenticate with an internal service credential; every adapter operation also supplies an authenticated owner. Public IDs are distinct from Convex document IDs. Large tool output spills and attachments go through Convex file storage; only bounded previews go into live events and model context. Deleting a chat records tombstones and cancels active runs.

**Auth choice: Better Auth with a Convex-backed adapter.** It supports web cookie sessions plus iOS bearer sessions through one API, avoiding a browser-only token path. Auth tables are behind the server API and session revocation is authoritative in Convex. A hot Redis session cache is bounded by session expiry and invalidated on sign-out. Password hashing and token generation belong to the auth implementation; provider API keys are separate user-owned secrets. If deployment cannot run the selected auth adapter, startup fails explicitly. No production shared development bearer token is accepted.

Provider keys, connector header tokens and OAuth tokens are encrypted at rest using AES-256-GCM with a random 96-bit IV, a 256-bit PRAXIS_ENCRYPTION_KEY, and owner/resource binding as authenticated data. Encryption errors never fall back to cleartext. API reads expose only masks. Model/tool caches never contain keys. OAuth uses server-side PKCE with expiring, single-use state bound to the user and an allowlisted return URL; DCR and hosted CIMD are supported through the official MCP SDK. Remote connector URLs and provider endpoints need an egress policy: deny private/link-local/metadata destinations in production and revalidate redirects, while local mode may allow test servers. Per-host AI data consent is enforced before outbound model/MCP/voice requests.

## Cache and sync

Redis key namespace is `praxis:v1:<owner>:...`: bootstrap snapshot; provider/model and connector/tool caches; session digest; run cancel flag; execution lease; run event stream/sequence; user change stream; rate limit buckets; JS conversation KV. Secrets and PII do not appear in keys (production owner keys are opaque). Bootstrap snapshots have a short TTL and are invalidated on every affected mutation. Model search and pagination run server-side, and bootstrap includes only the initial page. Cached values are owner-scoped. Rate limits apply by verified user with a separate unauthenticated/IP bucket. Request logs include request ID, route, status and duration, excluding bodies, query credentials, authorization, cookies and provider responses.

The sync experiment partitions entity hashes into a deterministic tree over stable entity keys. Canonical JSON has sorted object keys, UTF-8 encoding, explicit tombstones and SHA-256; Swift can reproduce it. Cursor sync uses a monotonic revision cursor (not wall-clock equality) so simultaneous updates are not skipped. `/v1/sync/*` supplies snapshots, changed entities and tree nodes; clients apply updates transactionally to IndexedDB or iOS persistence. The benchmark compares cursor and Merkle at 1k chats/50k messages, with 0,1,50 changed rows, reporting bytes, round trips and elapsed time. The winner stays default and the other remains feature-flagged; details in `docs/SYNC_EXPERIMENT.md`.

## Dependencies and deployment

Runtime dependency inventory (features add their package only when implemented):
- hono: small router and standards-based streaming API.
- @hono/node-server: local Node HTTP listener only.
- zod: JSON boundary validation and shared inferred types.
- (no @vercel/functions: `src/wait-until.ts` reads the platform request context directly; the package's OIDC chain pinned a vulnerable zod.) Durable work uses QStash.
- @upstash/redis: Redis REST access for streams, cache, leases and cancel.
- @upstash/qstash: signed continuation delivery and verification.
- @upstash/ratelimit: shared per-user rate limiting.
- convex: server data/storage client and function schema.
- better-auth: cookie and bearer session lifecycle.
- @modelcontextprotocol/sdk: official remote MCP transports, OAuth, tools/resources/prompts/elicitation.
- quickjs-emscripten: bounded in-process QuickJS WASM execution; no Node eval.
- typescript, @types/node: strict compiler and Node 24 API types (development).
- vitest: hermetic loop, API, adapter and sync tests (development).
- tsx: local TypeScript launcher (development).
- esbuild: small production Node bundle verification (development).

No accounts/projects are created or deployed by agents. Required credentials, external setup, callback URLs and rollout limits are listed in DEPLOY.md. Real adapter suites run only when their environment is supplied. Local tests and scripted smoke runs need none. Production feature claims must distinguish implemented contracts from credential-gated verification and known gaps.

- sharp: server-side orientation-aware image cropping and scaling for the vision reader on Vercel.

- fflate: small in-memory streaming ZIP decoder for skill imports; declared and actual sizes, entry types, paths and counts are bounded before persistence. Tar parsing and bounded gzip use Node built-ins.
