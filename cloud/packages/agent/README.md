# Agent harness

`runTurn()` (`src/harness/turn.ts`, PRA-169) runs one workflow turn: one model call, then that
response's tool calls through PRA-76's `executeBoundary` and permission decision table. It returns
a `TurnOutput` for the caller's fenced commit. The model call goes through an injected `generate`
port on the AI SDK (`ai`). In production, `cloud/convex/agent/component.ts` binds that port to the
Convex Agent component (`@convex-dev/agent`, `Agent.generateText`) inside the `turns.run` action,
with no thread and no component storage. Package tests call the AI SDK's `generateText` directly.
This package imports no Convex, Vercel or Upstash code. The legacy `AgentRunner` stays until PRA-46.

## Model and messages

- `openRouterTurnModel(key, modelId, effort)` builds the AI SDK model with the user's own key.
  The key is a `SealedSecret` and is revealed only into this request's provider.
- Usage accounting is on, so the response metadata carries `usage.cost`.
- `requestMessages(history)` maps stored rows to AI SDK messages through the model view in
  `model-messages.ts`. It fails closed on invalid rows. It answers a crashed turn's dangling call
  with an interrupted result in the request only, and drops empty responses from the request only.
- `toAiMessages` / `fromAiMessages` (`src/harness/ai-messages.ts`) round-trip without loss.
  Every stored field the AI SDK part cannot express rides under `providerOptions.praxis`, which
  providers ignore.
- A message's `raw.reasoning_details` goes on the assistant message as
  `providerOptions.openrouter.reasoning_details`. The OpenRouter provider replays it unchanged,
  Anthropic signatures and encrypted reasoning included (`openrouter-turn.test.ts`).

## Tools

- Tools reach the model as definitions only (`toolDefinitions`): no `execute` and no AI SDK
  validator.
- The harness runs each call itself, sequentially in model order:
  1. it checks the frozen offered schema;
  2. it runs `executeBoundary` with the exact approval receipt;
  3. it joins taint monotonically.
- A tool's own `boundary` (the web tools) wins over the injected registry.
- Unknown tools and malformed input become `policy-denied` / `schema` results, not crashes.
- The component's own `needsApproval` flow is not used: approvals stay structural receipts.

## Durable ledger (`TurnLedger`)

Convex implements the ledger in `cloud/convex/agent/ledger.ts`. Its rows are `toolState` rows of
kind `turnLedger`, keyed by run, generation and turn index.

- `saveResponse` stores the model output (`SavedResponse`, at most 900 KB) before any tool runs.
  A retried attempt replays it through `ledgerModel` instead of making a second paid call.
- `startCall` atomically marks a call started before its effect.
- `saveCall` stores the result with its taint.
- A started call with no result is `uncertain`. It throws `UncertainToolCall` on every retry,
  never a blind re-execution. The same holds for any exception after dispatch.
- `active()` is false once the run is stopped or fenced. The harness checks it before saving a
  response, before each call and before returning output. Every ledger mutation re-checks the fence.
- 401 and 402 return `{state: 'failed'}`. Other provider failures throw, so the workflow's bounded
  retry runs.

`MemoryLedger` (`turn-fixture.ts`) is the in-memory test double. `rehydrated()` simulates a fresh
attempt that reads the same durable rows as JSON.

## Tests

- **Fake model.** `fakeLanguageModel(script)` is a deterministic AI SDK `LanguageModelV4`. It gives
  fixed call ids, signed reasoning in OpenRouter metadata, usage and cost, and scripted HTTP failures.
  It comes with `fakeTools()` and `fakeRegistry`.
- **`turn-scenarios.test.ts`:** text, tools, approval, nested approval, error, long, compaction and
  vision, plus the edge cases.
- **`turn.test.ts`:** the PRA-78 properties carried over: replay stability, cancel fence, uncertain
  calls, receipts and the mode table.
- **`ai-messages.test.ts`:** the round trip on the captured `hello-replay.json` chat, the legacy
  decoder's turns and turns committed by this harness.

## Prompt bytes

`frozenPrompt` sorts unique tool names, canonicalizes schema bytes and appends the collaboration
instructions when the subagent tools are present. Dynamic content belongs at the tail. It never
changes the frozen system or tool prefix (`TURN_SYSTEM` is the 200-byte default).
