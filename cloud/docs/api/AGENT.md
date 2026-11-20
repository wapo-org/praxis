# Agent core integration

`@praxis/agent` exports a pure TypeScript durable state machine. It never imports API or infrastructure modules. All persistence/event/cancel/spill operations carry `userId`. The API scheduler must serialize each run with a lease or equivalent; no simultaneous workers for a checkpoint.

```ts
import {createScriptedRunner} from '@praxis/agent';
const runner = createScriptedRunner({
  save: async (userId, checkpoint) => { /* persist chat/setup/run + append new messages + checkpoint */ },
  emit: async (userId, runId, event) => { /* append RunEventPayload; return event sequence */ },
  isCancelled: async (userId, runId) => false,
}, 'approval');
const checkpoint = await runner.run({userId, chat, run, messages}, 8);
// messages ALREADY contains the persisted new user message. The runner never duplicates it.
// Persist checkpoint as JSON; don't hold the function alive when awaiting input.
const resumed = await runner.resume(checkpoint, approvalDecisionOrElicitationResponse, 8);
// budget exhausted: run.status='continuing'; enqueue runner.advance(checkpoint, 8).
// step(checkpoint) performs one model or tool step; cancel(checkpoint) closes parked runs.
```

`run` freezes `chat.setup` if absent and preserves existing setup. `ports.save` receives detached snapshots. Returning a sequence from `emit` updates `run.lastEventId`. Terminal runs emit `run.finished`. `step`, `advance`, `resume` and `cancel` return a complete checkpoint. The API owns initial user-message persistence, scheduling, auth, durable event IDs, SSE, and store transaction semantics. Save + event emission are separate calls: production adapters must coordinate an outbox/idempotent delivery if atomic crash recovery across these boundaries is required.

Default limits: 40 iterations, 8192 output tokens, 3 retries, 5 server pauses, 120 second operation timeout, 16 million response characters including streamed deltas/final payload, 32,000 tool result characters. Overrides live on `RunInput` / `AgentRunnerOptions`. Passing `maxSteps` parks continuations at boundaries; a single provider/tool operation is bounded by timeout, not preemptively handed off. Configure this below the host's remaining function budget.

Tool ports use `AgentTool {spec, hidden?, execute(args, context)}` and return `{content: JsonObject[], isError, outputRef?}`; `textResult` is convenient. API `FeatureTool` values can be wrapped by constructing their protocol `ToolSpec`, forwarding context and turning their JSON return into a text result. Inputs cross Zod boundaries; injected tools must also validate against their own schema before effects. Frozen tools missing from the live registry return errors. Hidden tools are callable from `context.callTool`, never directly from provider output. Trust uses source IDs and schema fingerprints; provider names never gate behavior.

Nested tool calls and elicitations unwind immediately when parked. On resume the parent tool replays from its entry, with completed nested results memoized under deterministic ordinal call IDs. **Parent tools must be replay-safe**: perform effects via `callTool` (memoized) or use `context.callId` as an external idempotency key, and request elicitation before effects. A changed invocation on replay fails. `context.signal` aborts on cancellation/timeouts; uncooperative work is abandoned and late results cannot commit. An external side effect cannot be undone by aborting; its adapter must implement idempotency. Elicitation replies are JSON validated; schema-specific checks belong to the eliciting feature adapter.

The transcript is append-only, including repair results after interrupted tool calls. Compaction creates a fingerprinted request view and never rewrites the persisted prefix or frozen setup. Inject `ports.summarize` for real summarization; scripted facade supplies a deterministic local summary. Inject `ports.spill` for persistent large outputs and provide `read_tool_output` in the tool registry.

The one-turn harness (`createTurnAgent`, `packages/agent/README.md`) has its own deterministic fake: `fakeChatModel(script)` streams scripted replies (fixed call ids, signed reasoning, raw payload) through the provider port, with `fakeTools()` and `fakeRegistry`; `turn-scenarios.test.ts` covers text, tools, approval, nested approval, error, long, compaction and vision.

Legacy runner scenarios: `text`, `tools`, `approval`, `nestedApproval`, `elicitation`, `error`, `long`, `compaction`, `vision`. `createScriptedRunner(ports, script)` supplies provider/tools/summary for immediate local API integration. `createScriptedProvider(script)` and `scriptedTools()` can be composed separately. Script state derives from the request transcript, so reconstructing the provider after a parked function works.

Dependencies: `@praxis/protocol` supplies authoritative DTOs/event schemas; `zod` validates checkpoint, provider, tool and resume boundaries. No additional runtime dependency.

## OpenRouter provider

```ts
import {AgentRunner, createOpenRouterProvider} from '@praxis/agent';
// apps/api resolves all of this in one call: OpenRouterModels.modelFor(userId, modelId, effort).
const provider = createOpenRouterProvider({apiKey: unsealedUserKey, capabilities: capabilitiesOf(catalogModel)}, guardedFetch);
const runner = new AgentRunner({provider, tools, ports});
```

OpenRouter with the user's own key is the only model provider, and streaming chat completions is the only wire format (`ModelProvider.stream`; there is no non-streaming path). `collectResponse(provider, request, signal)` drains a stream to its completed response for callers that do not render deltas (one-turn execution, titles). Every request asks for usage accounting, so the completed response carries tokens and `cost`. The endpoint is the pinned `OPENROUTER_API_BASE`, redirects are rejected, and the key travels as a `SealedSecret` that error text is redacted against.

Capabilities (tools, images, files, reasoning) and the effort sent come from the model's catalogue entry before the call (`capabilitiesOf`, `resolveEffort` in `apps/api/src/openrouter/catalog.ts`); nothing is learned by failing. A rejected request is never retried with tools, images or effort stripped.

Failures are a typed `ProviderFailure` (`provider-error.ts`) with a `kind`, a `retryable` flag and user-facing `remediation`. HTTP statuses classify through `classifyHttp` from `@praxis/credentials`, by status alone (no message body is passed, so quota wording never decides credit): 401 `keyInvalid`; only 402 is `creditExhausted`; 403 is a moderation refusal (`fatal`, not a bad key, whatever its wording); every 429 is `rateLimited`, including quota-worded ones; 5xx/408 are `unavailable`. 429 and 5xx/408 honour an explicit Retry-After. Other statuses become `context` (413 or context-length text), `modelUnavailable` (404 or unknown-model text), and otherwise `fatal`. A 400 that mentions credits is `fatal`. Only `rateLimited` and `unavailable` retry inside a turn; `context` compacts once. `keyInvalid` and `creditExhausted` end the run with `model_key_invalid` / `model_credit_exhausted`, and in `runOneTurn` they end the turn as `failed` and release the claim. Inside a tool (the image reader) a failure becomes a `ToolError` carrying the same remediation.

`buildProviderRequest`, `parseSSE` and `decodeOpenAIChat` are exported for focused tests. `buildProviderRequest` renders the wire from the mapper's model view (`toModelMessages`), so tool results stored in an assistant-role message (what the one-turn harness commits) become `tool` messages after the replayed response. Streaming uses incremental UTF-8 decoding and CR/LF/CRLF SSE framing with bounded total, event and line buffers. Merged `reasoning_details` are kept on the assistant message's raw payload and replayed unchanged on the next request.

Argument-sensitive tool policy: `AgentTool.classify?(args): {traits: ToolSpec['traits']; policyKey?: string}` lets trusted adapters classify a resolved target (for example `save_skill` create vs replacement). The runner applies those traits to the frozen spec for policy only. Classification traits plus `policyKey` are hashed into the approval key alongside the frozen description/schema. The frozen catalog stays byte-identical. A classification change during parking revokes the one-shot approval and asks again. The adapter must enforce the actual effect, including rejecting an existing-skill write when `replace` is false; classification does not replace execution-time checks.
