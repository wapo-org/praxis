# Praxis Chat — on-device agentic loop: implementation plan

Status: plan, rev 2 (2026-10-21). Nothing here is implemented yet.
Scope: replace `DemoAgentEngine` with a real, simple-but-complete agent loop
running on device: LLM API → tool calls → local execution → loop.

Confirmed decisions:
- **Providers:** any **Anthropic-compatible** (`/v1/messages`) or
  **OpenAI-compatible** (`/v1/chat/completions`) endpoint — user supplies
  base URL + key. Official Anthropic / OpenAI are presets, not special cases.
- **JS runner:** QuickJS-NG, vendored, **with web access** (`fetch`).
- **No "Code execution" toggle.** JS execution availability is decided by the
  mode (see §1 mode table).
- **MCP:** user may install **any MCP server that runs remotely** (reachable
  by URL). Anything that would start a server/process on device (stdio
  `command`/`args`, npm/pypi/docker packages) is rejected at install time.
  No curated allow/deny list by vendor.
- **No hosting anywhere** — including OAuth: no hosted redirect domain, no
  hosted client metadata document.
- **Skills:** supported, scripts dropped.

API details (beta header names, tool version strings) were gathered from docs
during research — re-verify each against live docs when implementing.

---

## 0. Ground rules that shape everything

1. **The transcript is append-only.** Never mutate the system prompt, the
   tool list, or any prior message between requests. Anthropic (Opus 5.5,
   newer accounts) rejects prefix edits with 400; on every provider, edits
   kill prefix caching and invalidate reasoning signatures. Consequences:
   - Tool set + system prompt + skill catalog are **frozen per conversation**
     at first send.
   - Mode / effort changes are **appended** as messages, never edits.
   - Tools disallowed in a mode are refused at execution time with an error
     result — never removed from the tool list.
   - Retry/edit only truncate from the tail (already how `ChatStore` works).
2. **Provider payloads are stored as raw JSON bytes** and replayed verbatim
   to the same provider flavor (signatures, encrypted reasoning, server-tool
   blocks). Our own encodes use `.sortedKeys`.
3. **Never parse SSE with `AsyncBytes.lines`** — it drops the blank lines that
   delimit events. One byte-level SSE parser shared by both LLM adapters and
   the MCP client.
4. **No per-delta work on the main actor.** The engine coalesces; the UI gets
   ≤ 60 flushes/s.
5. Every tool has a **read-only / destructive classification** and goes
   through one approval policy — including MCP calls made from JS code mode.
6. **Capabilities, not provider names**, gate features. A "compatible"
   endpoint may implement only part of the official API.

---

## 1. Target architecture

The agent runtime lives outside the app as a local Swift package
(monorepo-style), testable with `swift test` on macOS:

```
Packages/PraxisAgent/
  Sources/AgentCore         loop, events, transcript, tool contracts/policy, SSE, HTTP seam
  Sources/AgentProviders    Anthropic-compatible + OpenAI-compatible adapters
  Sources/AgentSkills       skill store/importer, load_skill / read_skill_file
  Sources/CQuickJS          vendored quickjs-ng + C shim
  Sources/AgentJS           QuickJS runner, run_javascript (console, timers, fetch, fs, kv)
  Sources/AgentMCP          remote MCP client, auth, installer, tool adapter
  Sources/AgentTestSupport  ScriptedProvider / ScriptedTransport / helpers
PraxisChat/                 app: maps AgentEvent → transcript UI, persistence, settings
```

Original module sketch (names map onto the package targets above):

```
PraxisChat/
  Agent/
    Engine/      AgentEngine (protocol), RunRequest, AgentEvent, AgentRun (actor),
                 LoopStateMachine, TurnReducer (pure), Coalescer, ContextManager
    Provider/    ModelProvider (protocol), ProviderProfile, Capabilities,
                 Transcript (neutral items + raw payloads),
                 Anthropic/{Adapter, StreamAccumulator}, OpenAIChat/{Adapter, StreamAccumulator},
                 SSEParser, HTTPTransport (URLSession | Scripted), RateLimiter
    Tools/       AgentTool (protocol), ToolRegistry (frozen snapshot), ToolPolicy
                 (mode × traits × trust), ApprovalCenter, ResultLimiter, OutputSpill,
                 SchemaSanitizer
    Skills/      SkillStore, SkillImporter (zip, validation), load_skill / read_skill_file
    JS/          JSRunner (protocol), QuickJSRunner (actor on dedicated executor),
                 HostBindings (console, timers, fs, kv, tools.*), run_javascript tool
    MCP/         MCPTransport (Streamable HTTP dual-era, legacy SSE fallback),
                 MCPClient (actor per server), MCPToolAdapter, MCPGateway,
                 MCPAuth (discovery, DCR, PKCE, refresh, manual creds),
                 MCPInstaller (URL / JSON config / registry, remote-only filter)
    Persistence/ ConversationStore (actor, JSON per conversation + index),
                 AttachmentStore (files on disk), Keychain
  Packages/QuickJSKit/   vendored quickjs-ng C + tiny C shim (SwiftPM local package)
```

### 1.1 Providers (Anthropic-compatible + OpenAI-compatible)

```swift
struct ProviderProfile: Codable, Identifiable {
    var id: UUID; var name: String
    var flavor: Flavor              // .anthropicMessages | .openAIChat
    var baseURL: URL; var keyRef: KeychainRef; var extraHeaders: [String: String]
    var capabilities: Capabilities  // preset defaults, overridable, partly probed
    enum Flavor: String, Codable { case anthropicMessages, openAIChat }
}
struct Capabilities: Codable {
    var tools = true, parallelTools = true, vision = true, streamUsage = true
    var reasoning: ReasoningControl     // .none | .anthropicEffort | .openAIReasoningEffort
    var reasoningReadback: ReasoningReadback // .none | .anthropicThinking | .reasoningContent | .reasoningField
    var imagesInToolResults: Bool       // Anthropic yes; OpenAI chat → re-send as user image
    var promptCaching: Caching          // .anthropicExplicit | .automatic | .none
    var serverWebSearch: Bool           // Anthropic official only
    var serverCompaction: Bool          // Anthropic official only
    var toolSearch: Bool                // Anthropic defer_loading
    var midConversationSystem: Bool     // OpenAI system/developer role: yes
}
protocol ModelProvider: Sendable {
    func listModels() async throws -> [ModelInfo]          // GET /v1/models (both flavors)
    func stream(_ req: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error>
}
```

Presets: **Anthropic**, **OpenAI**, **OpenRouter** (both flavors),
**Custom (Anthropic-compatible)**, **Custom (OpenAI-compatible)** — e.g.
LM Studio / Ollama / vLLM / llama.cpp on the LAN, Groq, Together, DeepSeek.
Custom profiles start with conservative capabilities. A "Test connection"
button lists models and runs a 1-tool probe request to detect tool support.

**Neutral transcript.** Each turn stores neutral items — `userText`,
`userImage`, `assistantText`, `reasoning(summary, raw)`,
`toolCall(id, name, argsJSON)`, `toolResult(id, content, isError)` — and
each assistant message keeps `raw: (flavor, Data)`. Same flavor → replay raw
verbatim. Different flavor (user switched provider mid-chat) → rebuild from
neutral items and drop opaque reasoning; the UI marks the switch. Model
switches within a profile are allowed; the model is recorded per turn.

**Wire differences each adapter absorbs:**

| Concern | Anthropic-compatible | OpenAI-compatible (chat completions) |
|---|---|---|
| Stream grammar | named events; `content_block_*` by index; `message_delta` stop_reason + usage | `data:` chunks; `choices[0].delta.content`; `delta.tool_calls[i]` arg fragments by index; `finish_reason`; `data: [DONE]`; usage only with `stream_options.include_usage` |
| Stop reasons → loop | `end_turn`, `tool_use`, `max_tokens`, `pause_turn`, `refusal`, `model_context_window_exceeded` | `stop`, `tool_calls`, `length`, `content_filter` (some servers send `tool_calls` with `stop` — trust presence of tool calls) |
| Tool results | `tool_result` blocks in one user message | one `role: tool` message per call (`tool_call_id`) |
| Images in tool results | inline | text stub + follow-up user image message |
| Reasoning | `thinking` blocks with signature, replay verbatim | `reasoning_content` / `reasoning` field (vendor-specific), not replayed unless the vendor requires it |
| Effort | `output_config.effort` | `reasoning_effort` (only if the model supports it; else ignored) |
| Mode/effort change mid-chat | appended system message if supported, else a tagged text block prepended to the next user message | appended `system`/`developer` message |
| Caching | explicit `cache_control` breakpoints | automatic prefix caching (stable prefix helps) |
| Tool names | `^[a-zA-Z0-9_-]{1,64}$` (use the stricter common subset everywhere) | same |
| Schemas | permissive | many local servers choke on `$ref`, `oneOf`, formats → `SchemaSanitizer` inlines/simplifies; never use `strict` |
| Errors mid-stream | `event: error` (e.g. overloaded) | error JSON chunk or connection drop |

### 1.2 Engine contract

```swift
protocol AgentEngine: Sendable {
    func run(_ request: RunRequest) -> AsyncStream<AgentEvent>
}
struct RunRequest: Sendable {
    var conversationID: UUID
    var transcript: Transcript          // prior turns + new user message
    var config: ConversationConfig      // frozen: profile, model, tools snapshot, system, skills catalog
    var mode: ChatMode; var effort: Effort
    var attachments: [AttachmentRef]
}
enum AgentEvent: Sendable {
    case text(blockID: UUID, append: String)            // already coalesced
    case textClosed(blockID: UUID)
    case thinking(stepID: UUID, summary: String)
    case stepOpened(Step)                               // carries toolCallID, source
    case stepInput(stepID: UUID, partialJSON: String)   // live code preview for run_javascript
    case stepAwaitingApproval(stepID: UUID, ApprovalRequest)
    case stepOutput(stepID: UUID, lines: [String], dropped: Int)
    case stepTrace(stepID: UUID, Trace)
    case stepClosed(stepID: UUID, StepOutcome)          // ok | error | denied | cancelled
    case usage(Usage)
    case retrying(attempt: Int, after: Duration, RetryReason)
    case transcriptCommitted([TranscriptItem])          // persistence + Turn.transcript append
    case finished(RunOutcome)  // done | maxTokens | refusal(category) | cancelled | failed
}
```

`DemoAgentEngine` is ported to the new events (previews, UI tests, App
Review demo mode — reviewers won't have a key). `LiveAgentEngine(provider:tools:clock:)`
is the real one.

### 1.3 Loop state machine (inside `actor AgentRun`)

`Preparing → Streaming → Evaluate → [AwaitingApproval] → ExecutingTools → Preparing …`
plus `Backoff`, `Compacting`, terminal `Done | Refused | Failed | Cancelled`.
Adapters normalize stop reasons to: `done`, `toolCalls`, `truncated`,
`paused`, `refused`, `contextExceeded`.

| Normalized stop | Action |
|---|---|
| `done` | finish (if empty right after tool results: one "continue" nudge) |
| `toolCalls` | validate args → policy → approvals → run all in a TaskGroup (per-tool timeout) → results in order (one Anthropic user message / N OpenAI tool messages) |
| `paused` (Anthropic `pause_turn`) | resend assistant content unchanged (cap ~5) |
| `truncated` | trailing tool call is incomplete → don't execute, retry with higher `max_tokens`; else continue |
| `contextExceeded` | `ContextManager` compacts, continue |
| `refused` | discard partial, never run its tools, show category |
| mid-stream error / 429 / 529 / 5xx / network | `Backoff` (honor `retry-after`; `RateLimiter` actor per profile), resend same body |

Guards: iteration cap by effort (8 / 20 / 40 / 80), wall-clock cap,
repeated-identical-call detector. If the model/profile has no tool support,
the run is plain chat and the mode chip says so.

Cancel (`stop()`): cancel Task → HTTP stream + tool group cancel → MCP
cancellation → JS interrupt. Then **repair the transcript**: drop the partial
assistant message, append "Cancelled by user" error results for every pending
tool call so the next request is valid on both flavors.

**ContextManager** (capability-driven): Anthropic official → server-side
compaction at ~150–200K and `clear_tool_uses` context editing. Everything
else → client-side compaction: summarize older turns with the same model
into a summary item that starts a new transcript segment (a deliberate
one-time prefix change; allowed on these providers). Threshold uses
reported usage, or a char-based estimate when the server doesn't report it.

### 1.4 Modes, effort, toggles

Tools are always registered (frozen list); the **mode decides what may run**:

| Mode | `run_javascript` | Skills | MCP read-only | MCP destructive / unknown | Web search |
|---|---|---|---|---|---|
| ask | refused | auto | refused | refused | if on |
| plan | **auto** | auto | auto (trusted) / ask | refused | if on |
| build | **auto** | auto | auto (trusted) / ask | ask | if on |
| auto | **auto** | auto | auto | ask unless "always allow" | if on |

JS is sandboxed (no native APIs, hard CPU/memory limits) and has `fetch`;
it never needs an approval prompt — it runs whenever the mode allows
execution. In plan mode `fetch` is limited to GET/HEAD. Every request is
shown as a network trace on the step. JS
code-mode calls into MCP tools still go through the MCP columns above.

| Control | Mapping |
|---|---|
| Model | profile `GET /v1/models`; recorded per turn |
| Effort low/med/high/max | Anthropic `output_config.effort`; OpenAI `reasoning_effort` low/medium/high/high; `max_tokens` 16K/32K/64K/128K (clamped to model limit); iteration cap |
| Web search toggle | Anthropic official → server `web_search` + `web_fetch`; otherwise shown only if the user has an MCP server providing search (bound at conversation start); else hidden |
| **Code execution toggle** | **removed** (`ChatStore.swift:14`, `PlusTray.swift:176`, UI test `PraxisChatUITests.swift:214-223`) |
| Memory toggle | hidden in v1 |
| Connectors | installed MCP servers (§Phase 4); per-conversation enablement |
| Attachments | image/document blocks (vision capability) and the JS `fs` |

Caching: Anthropic → one `cache_control` breakpoint on the last system block
+ top-level ephemeral; all flavors → tools sorted by name, no dates/names in
the system prompt, stable prefix. Test asserts cache reads on request #2
where the provider reports them.

---

## 2. Phases

Each phase ships green (`xcodebuild test`) and leaves the app runnable. Demo
engine stays the default until Phase 2 lands.

### Phase 0 — Foundations & streaming performance (no network)
1. **Engine seam.** `ChatStore(engine:conversations:)`; `RunRequest` instead
   of `(prompt, effort, model, webSearch)` (`ChatStore.swift:25,118-123`).
   Launch arg `-PraxisEngine demo|scripted|live`.
2. **Pure `TurnReducer`** extracted from `ChatStore.apply` (`:154-227`).
   Grouping rule: a step arriving when the last block isn't an open activity
   opens a new activity; any text closes it (arbitrary interleaving across
   loop iterations; removes the "Analyzing" string hack at `:172`).
3. **Models** (`Demo/Models.swift`): `Step.status/toolCallID/source/startedAt`;
   `CommandData.language/result/droppedLineCount/startedAt` (timer out of view
   state, `CommandView.swift:10,92`); `Turn.transcript`, `Turn.modelID`,
   `Turn.profileID`; Codable everywhere; attachment bytes → `AttachmentStore`.
4. **Concurrent runs:** `runs: [Conversation.ID: RunHandle]` replaces the
   single `runningTurnID` (`ChatStore.swift:22,114`); stop button reflects the
   selected conversation (`Composer.swift:27`). Fix: edit (`ChatStore.swift:78`)
   and history delete (`HistorySheet.swift:186`) stop runs on removed turns;
   auto-collapse task cancellable (`:138`).
5. **Remove the Code execution toggle** (store, PlusTray, UI test).
6. **Streaming hot path** (today O(n²) per message: `AgentMessage.swift:47`
   re-parses the whole source on every delta, twice via `onChange` → `revealed`):
   - Coalescer: 30–60 Hz flush + flush at block/step boundaries; one
     `updateTurn` per flush with cached turn location.
   - `LiveText` (`@Observable final class`) for the streaming block; reveal
     progress lives there (fixes re-fade on recycle, `AgentMessage.swift:35`).
   - Incremental markdown: keep parsed prefix, re-parse from the last
     top-level block only.
   - Per-block reveal clamp; `Equatable` block subviews (`InlineChips.swift:25-90`).
   - Command output: last ~200 lines in UI + dropped count; full log on disk;
     static part as one `Text` (`CommandView.swift:61-67`).
7. **Persistence:** `ConversationStore` actor, JSON per conversation + index,
   writes at commit points only.
8. **Tests:** reducer unit tests; perf `measure` of a 20 KB replay through
   reducer + incremental parser; `ChatStoreRetryTests` on the scripted engine.

### Phase 1 — Providers + text-only loop
1. `ProviderProfile` store + Settings UI (presets, base URL, key in Keychain
   `AfterFirstUnlockThisDeviceOnly`, extra headers, capability overrides,
   "Test connection"). Model picker backed by `/v1/models` per profile
   (replaces `MockData.models`, `PlusTray.swift:398-403`). AI-data consent
   screen naming the provider host (Guideline 5.1.2(i)).
2. Byte-level `SSEParser` (CRLF, multi-line `data:`, `id:`, comments,
   `[DONE]`; HTTP status checked first — errors are JSON). Timeout ≥ 300 s.
3. **Anthropic adapter** + accumulator (text / thinking+signature / tool_use
   `input_json_delta` / server-tool blocks whole / unknown blocks verbatim).
4. **OpenAI-chat adapter** + accumulator (content, indexed `tool_calls`
   fragments, `reasoning_content`/`reasoning`, `include_usage`, quirks:
   missing `index`, tool calls with `finish_reason: stop`, absent usage).
5. Loop without tools: all normalized stops, backoff, cancel/repair, usage.
6. `ScriptedTransport` fixtures per flavor (recorded from Anthropic, OpenAI,
   OpenRouter, one local server). Tests: chunks split mid-line, error
   mid-stream, 429 + `retry-after` on a test clock, cancel → valid transcript,
   retry/edit truncation, cross-flavor transcript rebuild.

### Phase 2 — Tool framework + skills + web search
1. `AgentTool` protocol:
   ```swift
   protocol AgentTool: Sendable {
       var name: String { get }; var description: String { get }
       var inputSchema: RawJSON { get }; var traits: ToolTraits { get } // readOnly, destructive, idempotent, openWorld, sandboxed
       var source: ToolSource { get }                                  // .builtin | .skill | .js | .mcp(serverID)
       func execute(_ input: RawJSON, _ ctx: ToolContext) async throws -> ToolOutput
   }
   ```
   `ToolRegistry` builds the frozen, name-sorted snapshot per conversation and
   emits it per flavor (Anthropic `tools` / OpenAI `functions`) through
   `SchemaSanitizer`. Strict local arg validation → error result on bad JSON.
2. `ToolPolicy` (mode table §1.4 × traits × server trust × "always allow")
   → allow / ask / refuse. `ApprovalCenter`: continuation keyed by tool-call
   id with cancellation handler; approval card in the activity step showing
   full input; "always allow" keyed by (server, tool, schema hash).
3. `ResultLimiter`: ~25K-token cap, head+tail + truncation note; full output
   spilled to disk; `read_tool_output(id, offset, limit)` to page.
4. **Skills (no scripts).** Bundled + imported (document picker / share
   sheet). Importer: unzip, reject traversal/symlinks/absolute paths, **drop
   `scripts/` and executable types**, caps (10 MB / 200 files / 64 KB
   SKILL.md), frontmatter rules. Catalog (name + description, sorted) frozen
   into the system prompt; mid-chat additions announced by appended message.
   Tools `load_skill(name)`, `read_skill_file(skill, path, offset?, limit?)`;
   read-only, auto in every mode; rendered as `.skill` traces.
5. **Web search:** Anthropic official → server `web_search`/`web_fetch`
   (blocks preserved verbatim, citations rendered, `pause_turn` exercised);
   other providers → toggle bound to an installed search-capable MCP server
   (Phase 4), else hidden.

### Phase 3 — JS runner (QuickJS-NG)
Why not JavaScriptCore: no public execution time limit or memory cap (a
model-written `while(true){}` or allocation bomb can't be stopped and can
jetsam the app; `JSContextGroupSetExecutionTimeLimit` is private → 2.5.1),
and no JIT in third-party apps anyway. QuickJS-NG measured ≈ JSC-without-JIT
on agent-shaped work, ~620 KB.

1. `Packages/QuickJSKit`: vendored quickjs-ng + C shim (value macros).
   `QuickJSRunner` actor on a dedicated `SerialExecutor` (own thread, large
   stack, `JS_UpdateStackTop`). Fresh context per call (~0.5 ms). Limits:
   interrupt handler (CPU budget + wall timeout), memory
   `min(128 MB, 25% os_proc_available_memory())`, stack 512 KB.
2. Host bindings: captured `console.*` (live → `.stepOutput`), Swift-driven
   `setTimeout/clearTimeout`, `TextEncoder/Decoder`, `structuredClone`,
   `crypto.getRandomValues/randomUUID`; read-only `fs` over the
   conversation's attachments (10 MB/file); per-conversation `kv` JSON store;
   **`fetch`** (http/https only, through the shared `HTTPTransport`, 10 MB
   response cap, ≤ 20 requests per run, GET/HEAD only in plan mode, each
   request emitted as a `.network` trace). No native APIs.
3. Tool `run_javascript {code, timeout_ms? ≤ 30000}`; async function body,
   `return` value is the result. Output JSON: console (200 lines / 16 KB),
   result (32 KB), error {name, message, line (wrapper-adjusted), stack},
   truncated, ms. Traits: sandboxed + openWorld → runs automatically in
   plan/build/auto, refused in ask. UI: `.command` step, code from streamed
   args, console lines, exit 0/1.
4. Async host → Promise bridge (`JS_NewPromiseCapability`, resolve on the
   engine actor, drain `JS_ExecutePendingJob`).
5. Tests: deterministic prelude (seeded `Math.random`, frozen `Date.now`,
   virtual timers); infinite loop / OOM / stack overflow → typed errors.
6. App Review framing: embedded sandboxed calculation/data tool, text/JSON
   output only, no native APIs (4.7.2), source visible in the step card.

### Phase 4 — Remote MCP
Own on-device client (~1.0–1.3k lines); the official swift-sdk 0.12.1 is
2025-11-25-only, pulls in swift-nio and is mid-churn on race/OAuth fixes —
used as reference/test oracle only. No server-side MCP connector (no per-call
approval, Anthropic-only).

1. **Install rule: remote only.** Sources:
   - *Add by URL* (+ optional headers).
   - *Paste config* — accepts `mcp.json` / `claude_desktop_config.json`
     shapes; entries with `url` (`type: http | streamable-http | sse`) are
     imported, entries with `command`/`args` are rejected with "runs a local
     process — not supported on iPhone".
   - *Browse registry* (`registry.modelcontextprotocol.io/v0.1/servers`):
     show only entries with a `remotes[]` URL; packages-only entries hidden;
     URL `{variables}` prompt the user.
   On install: connect, detect protocol era + auth requirements, list tools,
   show them for review. Replaces `MockData.connectors` and the PlusTray
   connector UI (`PlusTray.swift:211-232,432-458`).
2. **Transport (dual-era Streamable HTTP + legacy SSE fallback).** POST with
   `Accept: application/json, text/event-stream`; JSON or SSE replies.
   Modern 2026-07-28 (stateless, `server/discover`, `_meta`,
   `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) first →
   on 400 legacy `initialize` (2025-11-25 / 06-18) with `Mcp-Session-Id`
   (404 → re-init + replay) → if the URL only speaks 2024-11-05 HTTP+SSE,
   the legacy SSE transport. Era cached per origin.
3. **Messages:** discover/initialize, `tools/list` (pagination, `ttlMs`),
   `tools/call`, progress, cancellation, elicitation (form → SwiftUI sheet;
   URL → `ASWebAuthenticationSession`), `resource_link`/embedded text.
   Skip sampling/roots/logging (deprecated); prompts later.
4. **Tool mapping:** `mcp__<server>__<tool>` sanitized to the common name
   subset, ≤ 64 chars (hash suffix on collision); schemas sanitized;
   `isError` → error result; images → image blocks or follow-up user image
   per capability; `structuredContent` → compact JSON unless duplicated.
   Annotations feed `ToolTraits` but are untrusted until the user marks the
   server trusted (default: destructive).
5. **Auth — best effort, zero hosting, in this order:**
   1. No auth / static headers (API key, bearer PAT) — always works.
   2. OAuth 2.1 auto: 401 → `WWW-Authenticate resource_metadata` (fallback
      well-known) → AS metadata (RFC 8414 → OIDC) → **DCR** (`application_type:
      native`) → PKCE S256 + `resource` (RFC 8707) → `ASWebAuthenticationSession`
      with the app's **custom scheme** redirect → `state`/`iss` checks →
      Keychain tokens keyed by (issuer, resource), serialized rotating refresh,
      `insufficient_scope` step-up.
   3. If DCR rejects the custom scheme: retry registration with a
      **loopback redirect** (`http://127.0.0.1:<port>/cb`, spec-sanctioned)
      served by a one-shot in-app `NWListener` that lives only while the auth
      sheet is open, then cancel the sheet programmatically. *(Needs a spike
      on device to confirm.)*
   4. If the server has no DCR (needs a pre-registered app): ask the user for
      their own client ID (+ secret) or a token, with a link to the server's
      docs. Nothing is excluded up front; the server just reports which auth
      path it needs.
6. **Scale / tool bloat (provider-neutral):** connect lazily, cache tool lists
   and auth metadata per origin, per-conversation enablement. Above ~30 MCP
   tools in a conversation, switch exposure to **gateway mode**: instead of N
   tools, register a fixed trio — `mcp_search_tools(query)`,
   `mcp_describe_tool(server, tool)`, `mcp_call_tool(server, tool, args)` —
   plus JS code-mode stubs. The tool list stays frozen and small on every
   provider. (Anthropic official may use native tool search instead.)
7. Tests: scripted fake servers for both eras + legacy SSE, JSON and SSE
   replies, 404 re-init, 401 → discovery → DCR, config import rejecting stdio.

### Phase 5 — Code mode + resilience + polish
1. **Code mode:** `tools.<server>.<tool>(args)` stubs + type docs generated
   from MCP schemas into `run_javascript`'s description at conversation start
   (frozen). Each stub → `__host` → same `ToolPolicy`/approval as direct
   calls; ≤ 4 in flight, ≤ 25 per run; every call logged as a trace.
2. **Background/resume:** `beginBackgroundTask` around each request (~30 s);
   persist after every step with a tool *intent* record (call id, args hash,
   idempotent?). On resume: re-run missing results only for read-only /
   idempotent tools, else "outcome unknown" error or ask. Optional
   `BGContinuedProcessingTask` "keep running" behind a flag (review
   acceptance unverified). `NWPathMonitor` pause/retry.
3. Low Power / thermal → suggest lower effort; 30 Hz flush.

---

## 3. Bottlenecks & mitigations

| Bottleneck | Where | Mitigation | Phase |
|---|---|---|---|
| Full markdown re-parse ×2 per delta (O(n²)) | `AgentMessage.swift:47,59`, `PraxisMarkdown.swift:81` | coalescing + `LiveText` + incremental tail re-parse | 0 |
| Every paragraph redraws per reveal frame | `InlineChips.swift:25-90`, `AgentMessage.swift:69` | per-block clamp, Equatable block views | 0 |
| `src + chunk` copies; ActivityData CoW per output line (O(L²)) | `ChatStore.swift:187-217` | `LiveText`, batched lines | 0 |
| One main-actor hop per event | `ChatStore.swift:121` | 30–60 Hz engine-side flush | 0 |
| Single global run; edit/delete orphan runs | `ChatStore.swift:22,78,114`, `HistorySheet.swift:186` | per-conversation `RunHandle`s | 0 |
| No persistence; inline image bytes | `ChatStore.swift:8`, `Models.swift:68` | JSON per conversation, `AttachmentStore` | 0 |
| "Compatible" endpoints implement partial APIs | providers | capability flags, conservative custom defaults, Test connection probe | 1 |
| Two wire formats, different tool/reasoning shapes | providers | neutral transcript + raw replay per flavor | 1 |
| History immutability / prefix caching | providers | frozen config, appended mode/effort changes, compaction strategy per capability | 1–2 |
| `AsyncBytes.lines` drops SSE separators | WapoApp decoder pattern | byte-level SSE parser | 1 |
| Local/compatible servers reject complex JSON Schema | providers | `SchemaSanitizer` | 2 |
| Large tool results | MCP / JS | cap + spill + `read_tool_output` | 2 |
| Prompt injection via tool/web output | all tools | mode policy, untrusted annotations, schema-hash always-allow | 2 |
| JSC can't be interrupted / memory-capped | JS | QuickJS-NG limits | 3 |
| Interpreter speed (no JIT) | JS | CPU budget, prompt guidance | 3 |
| Many MCP tools → token cost, weak models degrade | MCP | per-conversation enablement, gateway mode at > 30 tools | 4 |
| Three MCP transport generations in the wild | MCP | dual-era + legacy SSE fallback, era cached per origin | 4 |
| OAuth redirect must be https/localhost per spec; no hosting | MCP auth | custom scheme → loopback fallback → user-supplied creds/token | 4 |
| App suspension kills streams in ~30 s | iOS | step-level persistence + resume; optional BGContinuedProcessingTask | 5 |
| Key exposure | BYOK | Keychain per profile | 1 |
| App Review: no key, AI data consent, JS execution | App Store | demo mode, consent screen, JS framing in review notes | 1 / 3 |

---

## 4. Remaining open points (non-blocking)

- Loopback OAuth redirect on iOS (Phase 4.5.3) needs a device spike.
- `BGContinuedProcessingTask` App Review acceptance for an agent loop.
- Re-verify Anthropic beta header names / tool version strings at
  implementation time.
