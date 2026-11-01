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

Local scenarios: `text`, `tools`, `approval`, `nestedApproval`, `elicitation`, `error`, `long`, `compaction`, `vision`. `createScriptedRunner(ports, script)` supplies provider/tools/summary for immediate local API integration. `createScriptedProvider(script)` and `scriptedTools()` can be composed separately. Script state derives from the request transcript, so reconstructing the provider after a parked function works.

Dependencies: `@praxis/protocol` supplies authoritative DTOs/event schemas; `zod` validates checkpoint, provider, tool and resume boundaries. No additional runtime dependency.

## HTTP providers and model discovery

```ts
import {createHTTPProvider, AgentRunner} from '@praxis/agent';
const provider = createHTTPProvider({
  providerId: savedProvider.id,
  flavor: savedProvider.flavor, // anthropicMessages | openAIChat | openAIResponses
  baseUrl: savedProvider.baseUrl,
  apiKey: decryptedKey,
  capabilities: savedProvider.capabilities,
  extraHeaders: decryptedHeaders,
}, injectedFetch);
const models = await provider.listModels(abortSignal); // protocol Model[]
const runner = new AgentRunner({provider, tools, ports});
```

`createHTTPProvider(config, fetcher?)` validates configuration with Zod and returns an `HTTPProvider`: existing `ModelProvider.stream(request, signal)` plus `listModels(signal?)`. It adds API-family auth headers, uses a fixed Anthropic `2023-06-01` compatibility version unless `extraHeaders` overrides it, and preserves custom base URL prefixes. Known full endpoint URLs are normalized. HTTP redirects are rejected to prevent credentials moving to another endpoint. HTTP/stream error messages redact configured secrets. No key is stored in a checkpoint or returned in a model DTO.

Optional config: `systemRole: 'system'|'developer'`, `maxTokensField: 'max_tokens'|'max_completion_tokens'|'omit'`, `replayReasoning`, `webSearchToolType`, `maxStreamBytes`, `maxEventBytes`. Chat defaults to `max_tokens` for compatible servers; select `max_completion_tokens` when the endpoint requires it. Model lists expose known capabilities and raw effort values; unknown metadata inherits configured capability defaults. Anthropic list pagination is bounded. Names-only lists cannot establish a model's exact capabilities or efforts.

`buildProviderRequest(flavor, request, options?)`, `clampEffort`, `parseModelMetadata`, `providerURL`, `parseSSE` and each decoder are exported for focused integration/tests. Streaming uses incremental UTF-8 decoding and CR/LF/CRLF SSE framing with bounded total, event and line buffers. Responses API completed encrypted reasoning items and Anthropic signatures/opaque blocks are retained for same-flavor raw replay. Request-time tool/image/effort fallbacks never mutate the frozen prefix or transcript.

Scripted scenarios now emit reasoning deltas/finished events. Newly committed messages inherit `run.clientTurnId`. The `compaction` script uses a deliberately low threshold but still requires at least two messages, with an earlier prefix to summarize; a first-ever single-message conversation has no history to compact. Seed history or send a second turn to exercise it.

Wire formats were verified against official documentation and the frozen Swift fixture corpus:

- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic model listing](https://platform.claude.com/docs/en/api/models/list)
- [OpenAI Chat streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [OpenAI model listing](https://developers.openai.com/api/reference/resources/models/methods/list)

No additional runtime dependency was added for HTTP providers: injected native fetch and Web Streams perform transport and streaming.

Argument-sensitive tool policy: `AgentTool.classify?(args): {traits: ToolSpec['traits']; policyKey?: string}` lets trusted adapters classify a resolved target (for example `save_skill` create vs replacement). The runner applies those traits to the frozen spec for policy only. Classification traits plus `policyKey` are hashed into the approval key alongside the frozen description/schema. The frozen catalog stays byte-identical. A classification change during parking revokes the one-shot approval and asks again. The adapter must enforce the actual effect, including rejecting an existing-skill write when `replace` is false; classification does not replace execution-time checks.
