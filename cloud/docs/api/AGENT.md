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
