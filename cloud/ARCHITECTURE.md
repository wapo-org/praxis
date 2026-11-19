# Praxis Cloud architecture

## Components and boundaries

Praxis Cloud is an npm workspace running on Node 24 in Vercel Fluid Compute. `apps/api` uses Hono and one function entry; it validates JSON using `packages/protocol` Zod schemas. React signs in directly to Convex Auth v2; existing application data still uses the API until PRA-35. Swift auth moves in PRA-37. The web and iOS apps paint an existing local replica before requesting `/v1/bootstrap` and resumable user change events. Resource IDs are opaque strings, dates ISO-8601 UTC, and events plain discriminated JSON.

`packages/agent` is a platform-independent TypeScript state machine. It imports protocol types but no Vercel, Convex or Upstash modules. Storage, KV, ordered events, clock, fetch, model provider and tools are injected ports. `packages/sync` holds portable canonical serialization and the hash-tree experiment. `packages/types` has no dependencies and holds the two type-level guards: `SealedSecret` (key material that prints as `[redacted]` everywhere except `reveal()`; the OpenRouter key and every credential-pool value travel as one) and the branded `TenantId` with `deriveTenantId` (HMAC-SHA256; integrations adopt it in PRA-36). Convex functions and schema live in `cloud/convex/`; server-side adapter modules live under `apps/api/src/adapters/`. The Swift runtime is read-only reference. Its append-only transcript, mode policy and capability gates remain invariants.

The API selects local in-memory adapters only through a dedicated `dev:local` entry. Production startup refuses local/development authentication even if flags are misconfigured. The scripted provider exercises text, reasoning, tool execution, nested approvals, elicitation, error, compaction, vision activity and long runs with no external service. Production adapters are configured explicitly and never fall back silently to in-memory state.

## Lifecycle and durability

A client creates a chat, then posts a run with a client turn/idempotency key. Creation scopes all lookup keys by user and chat, rejects concurrent active runs, persists the user message and freezes the system prompt, tool specs and skill catalog once. The service schedules execution independently of the SSE reader. Each step loads a checkpoint, verifies ownership and a fenced execution lease, checks the durable cancel flag, then invokes provider or tool ports. Provider chunks emit ordered run events; completed responses and tools checkpoint transcript additions and loop state. The only model provider is OpenRouter with the user's own key (`apps/api/src/openrouter`, one OpenAI-chat wire path in `packages/agent`); the key is unsealed per execution slice and never checkpointed, capabilities come from the shared OpenRouter catalogue (1 h cache), and replay preserves the opaque assistant payload with its reasoning details. Request-time transformations handle capabilities, summaries and unsupported images without rewriting history. Provider failures are a typed `ProviderFailure` (`packages/agent/src/provider-error.ts`): only rate limits and outages retry inside a turn, and a rejected request is never retried with tools, images or effort stripped.

Approvals and elicitations persist their pending descriptor and park the run. A response POST validates the pending ID and decision, records it exactly once, and schedules the next step. A parked run holds no function. Nested calls carry parentCallId and traverse the same tool policy as top-level calls. Always-allow grants are keyed by tool schema fingerprint and never override a mode refusal. Cancel is a Redis flag checked between chunks and tool boundaries, and is reflected in the durable checkpoint. A dropped client connection only ends its SSE subscription, never the producer.

**Continuation choice: Upstash QStash.** A signed QStash callback schedules a bounded execution slice before the Vercel duration budget expires. It reuses the Upstash operations stack and permits a simple versioned checkpoint, rather than introducing replay-sensitive workflow code into the pure loop. The API verifies QStash signatures; the callback accepts only a run identifier, never user secrets. At-least-once delivery requires compare-and-set checkpoint versions, fenced leases and idempotent event append. External side-effect tools cannot promise exactly-once remote execution after a crash; their in-flight marker is persisted before invocation, and ambiguous non-idempotent work requires human recovery rather than blind replay. Local continuation uses the same scheduling port with a queued callback and tiny-budget tests. Deployment must not rely on fire-and-forget work after returning a response; production initial work is published durably before 202, and each continuation is scheduled before acknowledging its callback.

Events use one Redis Stream per run. A monotonically increasing numeric sequence is allocated atomically alongside XADD (explicit `<sequence>-0` Redis IDs). JSON and SSE expose that same sequence as the id. A reconnect resumes strictly after Last-Event-ID. The event stream remains the live replay log and the Convex checkpoint is the authoritative durable state; a checkpoint outbox bridges state commits to event publication, with stable IDs so retries deduplicate. Terminal streams replay and close; heartbeats keep active SSE connections alive. Streams have finite retention; a cursor older than retention yields cursor_expired rather than silently losing data. User-level streams announce mutations across devices. Token and cookie values never appear in logs or event URLs.

## Storage, auth and secret handling

Chats, committed messages, runs, workflow turns, sandboxes and offloaded output chunks live in typed Convex tables (`convex/domainSchema.ts`) whose indexes all lead with `userId`:

| Table | Indexes |
| --- | --- |
| `chats` | `by_user_id` (userId, id), `by_user_updated` (userId, value.updatedAt) |
| `messages` | `by_user_id` (userId, id), `by_chat_sequence` (userId, chatId, sequence) |
| `runs` | `by_user_id` (userId, id), `by_user_chat` (userId, chatId) |
| `turns` | `by_user_run_turn` (userId, runId, generation, turnIndex) |
| `sandboxes` | `by_user_chat` (userId, chatId) |
| `outputs` | `by_user_id` (userId, id), `by_user_output` (userId, parentId) |

Client functions (`chats.*`, `messages.page`, `runs.get/start/cancel`) take no owner argument: `convex/functions.ts` resolves the owner with `getAuthUserId` and rejects a missing session or a fenced account. Server writes such as `messages.commit` use `serverMutation`, which verifies the service token, and check that the supplied `userId` is active in the same transaction. Every typed read and write queries through an owner-first index, so a cross-owner ID resolves to nothing. A message commit allocates its sequence from the chat's `lastSequence` in the same transaction as the message row and its sync revision, so concurrent commits stay contiguous. The Store maps the `chat`, `message`, `run` and `outputChunk` kinds onto these tables; the generic `records` table holds only the remaining sync kinds. Generic values and sync revision snapshots are stored as JSON strings and decoded at the Convex Store boundary. `ACCOUNT_PURGE_POLICY` (`convex/accountTables.ts`) assigns every table a deletion policy, so a new table without one fails typecheck. `account:purge` drains the typed owner tables, cancels each owned workflow and deletes its `turns` and run, then removes generic records, the change log, embeddings and owner-bound files, all in bounded batches.

**Production authentication uses Convex Auth v2.** The API forwards each bearer to the configured Convex deployment. Ordinary requests use `auth:currentUser` to verify the session and check the active owner. Account deletion uses `account:deletionOwner` and `account:confirmDeletion` to restrict client retries to the confirming session. Convex schedules signed retries for fenced owners independently of their session.

For a Vercel Preview without working Google sign-in, set `PRAXIS_PREVIEW_MOCK_OAUTH=google` on the web build. Selecting Google then shows a simulated unavailable response. Email sign-in still uses the configured Convex deployment. Production builds always use the real provider hooks.

The user's OpenRouter key, connector header tokens and OAuth tokens are encrypted at rest using AES-256-GCM with a random 96-bit IV, a 256-bit PRAXIS_ENCRYPTION_KEY, and owner/resource binding as authenticated data. Encryption errors never fall back to cleartext. API reads expose only masks. Model/tool caches never contain keys. OAuth uses server-side PKCE with expiring, single-use state bound to the user and an allowlisted return URL; DCR and hosted CIMD are supported through the official MCP SDK. Remote connector URLs and the pinned OpenRouter endpoint use the production egress policy: deny private/link-local/metadata destinations in production and revalidate redirects, while local mode may allow test servers. Connecting OpenRouter grants model data consent; per-host consent still gates MCP requests.

## Cache and sync

Redis key namespace is `praxis:v1:<owner>:...`: bootstrap snapshot; the shared OpenRouter catalogue (`openrouter:catalog`, not per owner) and connector/tool caches; run cancel flag; execution lease; run event stream/sequence; user change stream; rate limit buckets; JS conversation KV. Secrets and PII do not appear in keys (production owner keys are opaque). Bootstrap snapshots have a short TTL and are invalidated on every affected mutation. Model search and pagination run server-side, and the catalogue is fetched separately from bootstrap. Cached values are owner-scoped. Rate limits apply by verified user with a separate unauthenticated/IP bucket. Request logs include request ID, route, status and duration, excluding bodies, query credentials, authorization, cookies and provider responses.

The sync experiment partitions entity hashes into a deterministic tree over stable entity keys. Canonical JSON has sorted object keys, UTF-8 encoding, explicit tombstones and SHA-256; Swift can reproduce it. Cursor sync uses a monotonic revision cursor (not wall-clock equality) so simultaneous updates are not skipped. `/v1/sync/*` supplies snapshots, changed entities and tree nodes; clients apply updates transactionally to IndexedDB or iOS persistence. The benchmark compares cursor and Merkle at 1k chats/50k messages, with 0,1,50 changed rows, reporting bytes, round trips and elapsed time. The winner stays default and the other remains feature-flagged; details in `docs/SYNC_EXPERIMENT.md`.

## Tool boundary

`packages/agent/src/boundary` provides deterministic capability policy, a restricted shell AST,
HMAC approval verification with an injected atomic replay store, structural taint joins and meta-tool unwrapping.
Wire schemas live in `packages/protocol/src/tool-boundary.ts`; the authenticated issuer and durable adapter
must remain server-owned. The current API adapter returns structured tool errors; the future Modal and
Composio executors adopt `executeBoundary` in PRA-56/57/48. This core does not replace the current runner.
Shell denials cannot be approved; unrecognized syntax fails closed and unknown commands require approval.
`boundaryDecision` permits untainted allow calls in Build/Auto when the adapter certifies workspace
confinement without secrets or network effects; tainted side effects and egress require verified receipts.
Auto also requires approval for destructive or untrusted writes; Ask/Plan deny all side effects.
Failures after tool execution carry `untrustedSource` and monotonic `taint` just like successes; rejections before
execution preserve incoming taint. Runners persist taint on both outcomes before dispatching the next call. Durable dispatchers keep uncertain outcomes fenced for reconciliation.

## Sandbox tools and browser CLI (PRA-77)

`packages/sandbox-tools` is the Modal v1 tool set: `shell`, `read_file`, `edit_file` (exact-match, then the
workspace's `.praxis/diagnostics.json` checks inline), `replace_symbol` (Python/TypeScript/JavaScript declarations, methods and dotted nested names),
`export_file`, `wait_for_job`, `notebook_run`, and per-turn git checkpoints
with rewind (PRA-63). Tools run only through `executeSandboxTool`, which goes through `executeBoundary`; `shell`
is classified by `shellPolicy`. They speak to a `SandboxPort`: an in-memory fake for tests, a local temp-dir port,
and `@praxis/sandbox-tools/modal`, which uses Modal's native exec and filesystem APIs (no in-sandbox server).
`@praxis/sandbox-tools/image` composes a digest-pinned Node Bookworm slim base and a snapshot-pinned
Python/git/build-tools/tmux layer; browser and per-harness layers extend it independently (see `sandbox/README.md`).
`packages/browser-cli` (`praxis-browser`) drives Chromium over CDP with accessibility-tree refs and no LLM;
it shares snapshot and screenshot capture with `praxis-verify`. Neither package may be imported by `apps/api`
directly while it is a Hono app (child_process lives in the local port and the browser session).

## Platform spend reservation (PRA-81 for PRA-22)

`packages/spend` (dependency-free) is the pre-reservation ledger for platform-paid calls only (Exa, Firecrawl,
Modal; OpenRouter is the user's key). `reserve` holds a worst-case estimate (integer micro-USD from the named
estimators) or returns `budget_exhausted`; `settle` charges the billed amount and refunds the rest; `release`
returns a call the provider never billed; every key is idempotent and charged at most once.
TTL expiry only marks an orphan: its amount stays held until reconciliation settles or releases it.
This is the pure core. PRA-22 still has to persist it, with each operation as one Convex mutation over the user's
account row so parallel sub-agents are serialized; nothing calls it in production yet. fast-check properties check
PRA-75's `AtomicSpendCap` and `ChargeOnce` on interleaved, serially applied operations, TTL expiry included.

iOS OpenRouter PKCE: `ASWebAuthenticationSession` opens OpenRouter with `callback_url` set to the hosted
`/settings/openrouter/app-callback`, which needs no session and only forwards a well-formed `code` to
`praxis-app://openrouter/callback`; the app holds the verifier and exchanges the code itself.

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
- @modelcontextprotocol/sdk: official remote MCP transports, OAuth, tools/resources/prompts/elicitation.
- quickjs-emscripten: bounded in-process QuickJS WASM execution; no Node eval.
- typescript, @types/node: strict compiler and Node 24 API types (development).
- vitest: hermetic loop, API, adapter and sync tests (development).
- tsx: local TypeScript launcher (development).
- esbuild: small production Node bundle verification (development).

No accounts/projects are created or deployed by agents. Required credentials, external setup, callback URLs and rollout limits are listed in DEPLOY.md. Real adapter suites run only when their environment is supplied. Local tests and scripted smoke runs need none. Production feature claims must distinguish implemented contracts from credential-gated verification and known gaps.

- sharp: server-side orientation-aware image cropping and scaling for the vision reader on Vercel.

- fflate: small in-memory streaming ZIP decoder for skill imports; declared and actual sizes, entry types, paths and counts are bounded before persistence. Tar parsing and bounded gzip use Node built-ins.

Sandbox dependency: `modal` **0.11.1**, pinned, the official Modal JavaScript SDK (sandboxes, exec, filesystem, volumes, tunnels), used only by `@praxis/sandbox-tools/modal` and its opt-in scripts.

Tool-boundary dependencies: `shell-quote` **1.12.0**, pinned, dependency-free pure JS token scanner for the restricted shell AST; `@types/shell-quote` **1.7.5** for compile-time declarations. `fast-check` **4.10.2**, pinned dev dependency, checks shell obfuscation and monotone taint properties; `npm test` runs the boundary suite; `npm run specs` runs the PRA-75 formal models.

### Composio environment

Set these variables on the Convex deployment that handles connections.

- `COMPOSIO_API_KEY` authenticates Connect Link creation and account revocation.
- `COMPOSIO_AUTH_CONFIG_<TOOLKIT_UPPER>` holds the Composio auth config ID for a toolkit, for example `COMPOSIO_AUTH_CONFIG_GMAIL`.
- `PRAXIS_TENANT_ID_SECRET` holds at least 32 bytes of stable HMAC key material. Changing it changes every Composio tenant ID.
- `COMPOSIO_WEBHOOK_SECRET` verifies signatures on deliveries to `<CONVEX_SITE_URL>/composio/webhook`.
- `PRAXIS_WEB_ORIGINS` lists the permitted HTTPS return origins, separated by commas. The native return is `praxis-app://oauth/callback`.

## Formal protocol checks

`specs/` models the v2 Linear designs before their implementations exist; see
`specs/contracts/README.md` for assumptions and the mapping to current code.
Pinned dev dependencies: `@informalsystems/quint` runs protocol simulations without
Java; `fast-check` generates checkpoint, API dedup/truncation and failover cases.
Run `npm run specs` for models and `npm test` for implementation properties.

`notebook_run` (PRA-105) uses a detached Python driver, one Jupyter kernel per sandbox, and file mailboxes
with OS locks across API workers. Timeouts interrupt the kernel; an unacknowledged interrupt stops it for restart.
Kernel restarts report "variables were lost".
PNG and HTML outputs pass through `export_file`; arbitrary notebook code requires an approval receipt.
The opt-in `PRAXIS_MODAL_NOTEBOOK_CHECK=1 npm run verify -- live notebook` suite records standard proof and composes a Jupyter layer
on PRA-51 via `sandboxNotebookImage()`; its checked-in `modal/notebook-requirements.lock` pins and hashes every Python dependency.
Pip installs wheels with `--require-hashes` and verifies the graph with `pip check`. Output-processing errors interrupt
and drain the active cell before returning; artifact count and encoded size are checked before decoding.
Workspace setup verifies the canonical cwd and a successful execute reply before dispatch; user-cell success also requires its execute reply.



## Convex Auth v2 (PRA-34)

Web sign-in uses the core, password, email, Google and Resend components. Apple sign-in was removed; re-adding it needs its component and four deployment variables.
The deployment owns credentials, JWT signing and session rotation; the React provider owns browser secrets and refresh.
Required deployment variables are declared in `convex/convex.config.ts`; missing values prevent deployment.
Only `SITE_URL` is allowed as the OAuth return origin (including the future iOS HTTPS handoff page).
Email validation and recovery land on `/validate-email` and `/reset-password`.
Verified emails shared across methods are rejected rather than automatically linked.
OAuth-first email collisions reject password verification transactionally; pending signup rows are not authenticated identities.
Account deletion fences the owner before purging data and blobs. The final batch erases the owner's `oauthEmails`, Convex Auth component credentials and user row in one transaction.
The API derives the application owner from the verified Convex session.

Dependencies:
- `@convex-dev/auth@2.0.0`: component authentication and browser session lifecycle (latest dist-tag confirmed v2).
- `@convex-dev/resend@0.2.10`: documented email delivery component for verification and recovery.
- `convex@1.50.0`: component environment declarations and deployment-signed JWT support.


Browser verification runs an isolated anonymous local Convex deployment with the production auth source and a test-only Resend component.
The dedicated local API entry can validate that deployment's identity via `PRAXIS_LOCAL_CONVEX_URL`; it never uses a dev token when configured.
The verification package uses `convex@1.50.0` to seed and inspect the local auth fixture.

Symbol editing dependencies (PRA-106): `web-tree-sitter` **0.25.10** runs the pure parser in-process;
`@vscode/tree-sitter-wasm` **0.3.1** supplies immutable prebuilt Python, JavaScript, TypeScript and TSX grammars.
No workspace code executes in the parser and no image layer is required; diagnostics still run through the sandbox port.
Each replacement preserves bytes outside the AST range (including BOM/CRLF); Python decorators belong to the range,
while export modifiers and leading indentation stay outside it. Single arrow/function/class bindings replace the whole
declaration; multi-binding declarations use `edit_file`. Unsupported extensions return that remediation without writing.
Edits and checkpoint/rewind operations serialize per workspace on the same port; the runner must retain the port
and serialize access across workers, as required by PRA-19. Syntax diagnostics remain inline and do not roll back edits.

## Stateful subagent core

`createSubagentHarness(port)` registers exactly the four shared tools and their boundary classifier.
Freeze its tool specs into the turn catalog and combine its classifier with the executable tool registry.
Its injected `SubagentHarnessPort` binds authenticated actor/tenant and stable child/message IDs,
commits reducer state and launch/wake/kill outbox atomically, and owns durable wait deadlines and wakeups.
PRA-114 implements that persistence port; PRA-116 supplies confinement and immutable handoff verification.
Trusted tool metadata filters default delegation grants; explicit server grants can allow approval-capable tools,
but every child action still passes the inherited one-turn boundary and receipts in its confined workspace.
Authorized model capabilities and effort lists are checked before create/configure/resume without clamping.
The harness joins adapter result taint before the next call; collaboration instructions are frozen and deterministic.
No production persistence or sandbox adapter is implemented by this registry.

`packages/agent/src/subagents` owns the pure addressed lifecycle reducer, permission narrowing,
ordered inboxes, asynchronous cascading cancellation and verified artifact handoffs (PRA-79).
The four wire tools and durable state schemas live in `packages/protocol/src/subagents.ts`.
`SandboxSubagentWorkspace` in `packages/sandbox-tools` binds a server-supplied TenantId, child and revision.
It requires Linux bubblewrap with `--bind-fd` and `--ro-bind-fd` support and Python in the provisioned sandbox image.
Preparation fails closed if the required mount or namespace setup fails. No packages are installed at runtime. Child commands receive
only their writable root plus read-only system runtimes, private PID/network namespaces and a cleared
environment. All child effects still require PRA-76 authorization; this adapter grants no outbound network.
The trusted launcher opens dynamic mount sources component by component without following symlinks.
Bubblewrap verifies each mounted object against its open descriptor before executing child code.
File operations use directory descriptors and O_NOFOLLOW to reject symlinks without a check/open race.
Their trusted script is installed outside child data and mounted read-only, runs from `/` with Python `-I`,
and receives binary writes through staged read-only files, never argv; staging is removed even on failure.
Built-in Python syntax diagnostics also use `-I` to prevent workspace or PYTHONPATH module substitution.
Snapshot capture rejects special files and enforces named count/byte limits, preserving executable bits.
Content-addressed manifests live outside child mounts under tenant/child/revision. Checks are server-configured
argv executed against a read-only snapshot; every open, check and artifact read verifies stored content.
Handoffs persist snapshot_sha256; opaque proofs are recreated by verification and never deserialized.
Explicit export must use the verified snapshot view and pass its own authority check; no automatic merge exists.
`completeSubagent` passes expected/next trees and the verified digest to PRA-114's atomic compareAndSwap;
the store must persist the digest and compare the complete expected tree, including parent cancellation.
`waitAgents` re-verifies snapshots and returns `{tree, result}`; PRA-114 must CAS-fence that state before exposure.
Discovery, waits, messages and terminal returns join structural taint before model-visible exposure.
PRA-58 owns durable handle registration, termination probing and idempotence: its injected cleanup must
verify tenant/child/revision ownership and return dead/absent only after confirmation, never kill a shared sandbox.
Uncertain cleanup remains cancelling. Authenticated workflow wiring and tool registration remain PRA-114/115.
`verify -- live subagent-workspaces` records required Modal and durable race evidence; fake tests are not live proof.
PRA-75's five named subagent invariants run as fast-check properties against the reducer.

### Optional sandbox browser (PRA-20)

`packages/sandbox-tools/src/modal/browser-image.ts` adds Chromium and the deterministic `praxis-browser` CLI above the tools image. The isolated runtime lock pins the existing Playwright, tsx and Zod dependencies and their transitives; Playwright pins Chromium, and system dependencies resolve against the base layer's frozen Debian snapshot. Only selected CLI/evidence sources enter the image. Stagehand and a model relay are deferred per PRA-101. Non-browser sandboxes keep the tools image.

The `browser` sandbox tool uses argv-only SandboxPort execution and chat-confined sessions. Its action-specific classification uses the existing approval/taint boundary; screenshots are bounded exports with verified SHA-256 proof. Browser provisioning must apply `browserSandboxOptions()` for public-only IPv4 egress and explicitly attest that restriction in the trusted tool context. `verify -- live browser` is opt-in and records installed image-directory apparent bytes and cold start with unconditional termination.

PRA-29 adds `@convex-dev/workflow` **0.4.10** for the durable flags-only loop; its workpool is capped at four jobs. `runs.start` atomically creates a run and workflow; the internal stub commits three turns with index-keyed flags. `onComplete` settles success, cancellation and failure; this skeleton acquires no external resources. PRA-30 replaces `turns.commitStub` with the authenticated worker, PRA-31 adds handoffs, and PRA-32 adds suspension/children. Unsupported flags fail closed until those handlers exist. `runs.start` resolves the owner with `getAuthUserId` (the Auth v2 token subject is a session). Account deletion fences the owner (`users.deleting`), so starts and stub commits fail closed; the purge cancels each owned workflow, cleans its journal, and deletes its turns and run.

## Built-in web tools (PRA-60)

`features/web` exposes `web_search` and `web_read` through AgentTool ports. Exa is
pinned to auto with at most ten results and no summaries; Firecrawl requests only
main-content Markdown with file parsers disabled, bounding each scrape to one credit.
`WebPorts` injects pooled platform credentials, guarded egress, accounting, cache and
output spill. Tool schemas remain identical when disabled or unavailable.
Each tool carries its PRA-76 classification (`AgentTool.boundary`: read plus
external-egress, untrusted source). The AgentRunner decides classified tools with
`boundaryDecision` (`run-boundary.ts`): egress asks for approval in Build/Auto and is
refused in Ask/Plan; always-allow applies only before taint. Executing an untrusted
source sets the checkpoint's `tainted` flag, which is also seeded from earlier
untrusted tool results in the chat; while tainted, non-read-only tools need a fresh
approval. `read_tool_output` is classified as an untrusted read.

The accounting RPC shapes (`WebSpendRequest`, `WebSpendSettlement`, admission) live
in `@praxis/protocol`; Convex derives its validators from them and parses with them.
Convex `webTools` actions authenticate the server before invoking internal atomic
mutations. User allowance, spend reservation and sliding hourly admission share a
transaction; provider attempts separately enforce global QPS/minute and browser
concurrency caps, including credential failover attempts. The pure `@praxis/spend`
ledger prices/reserves/settles calls. Completed call receipts are separate rows so
monthly ledger records do not accumulate closed-call history. Interrupted calls
retain reservations until reconciliation. A 2xx provider response is settled before
parsing, caching or spilling, so downstream failures never refund it; only calls that
never dispatched or got a non-2xx answer are released. PRA-22 owns allowance provisioning and orphan reconciliation.

The shared public-page cache uses the injected Upstash KV, a `praxis:v1` key with a
SHA-256 URL digest, a 15-minute TTL and schema validation. Query-bearing URLs bypass
shared caching. Cache errors fall through to the bounded provider call; accounting
errors fail closed. Long Markdown is persisted as owner/chat-scoped output and can
be paged with `read_tool_output`. No new third-party dependency is introduced.
