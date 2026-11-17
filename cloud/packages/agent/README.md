# Agent ports

`runOneTurn()` is an isolated PRA-78 prototype, not the current API execution path.
It calls the existing ModelProvider once, then handles that response's tools through
PRA-76's `executeBoundary` and permission decision table. It adds no runtime dependencies.
The existing AgentRunner stays until the PRA-14 migration.

## Durable adapter contract

`TurnStore` is a required injected port, not an in-memory production implementation.
PRA-7/13 must implement and verify it against Convex before adopting this prototype:

- `acquire` derives owner from trusted server context and atomically compares
  expectedTurnIndex, terminal/Stop state and exclusive attempt fence. Duplicate,
  future and concurrent deliveries return flags without calling a provider.
- A claim does not expire into automatic replay. Recovery first proves the old
  worker fenced; an interrupted model request may have incurred upstream usage.
- `saveResponse` persists a detached response, including raw reasoning and usage,
  before dispatch. Recovery reuses it without another model call.
- `startCall` atomically records the exact invocation and call ID before effects.
  A completed call returns its saved result; an ambiguous started call requires
  reconciliation through provider idempotency/status, never blind execution.
- All writes reject stale tokens. Stop, auth, connection validity and the attempt
  fence must also be checked by the dispatch adapter immediately before upstream I/O.
- Exceptions after dispatch retain an uncertain call and stop the batch, including typed errors
  and invalid results; only a returned result or pre-dispatch refusal completes a call.
- Model dispatch requires tools enabled, a frozen offered schema and an available, non-hidden adapter.
- `saveCall` persists result plus provenance/monotone taint, including errors.
- `commit` atomically stores messages, usage exactly once, joined taint, control
  flags and increments turnIndex under the fence. A lost reply returns saved flags.
  Stop owns a separate atomic partial/truncated commit; late worker commits lose.
- `fail` ends the turn as `failed` under the fence when the model call hits a revoked key or
  spent credit (`model_key_invalid` / `model_credit_exhausted` with remediation), releases the
  claim and keeps turnIndex; redelivery sees the failure, not `busy`. Suspending until the user
  reconnects and resuming belongs to PRA-32's `awaitEvent`.

Tests use an atomic fake and explicit JSON round-trips. They are not evidence of
implemented distributed persistence, full streaming truncation, live model fidelity,
or real provider idempotency. The prototype exposes tool refusals as structured
results; authenticated approval suspension/resumption belongs to PRA-21.
Nested `callTool` is denied; an adapter must surface nested work with its own ledger
and boundary rather than bypassing policy. Meta-tools use PRA-76's checked batch.

## Prompt bytes

`assembleTurnRequest` canonicalizes object keys, sorts unique tool names and preserves
message/array order. Dynamic memory belongs on a persisted newest-user-turn note;
it never changes the frozen system or tool prefix. `ONE_TURN_SYSTEM` is a 200-byte
candidate, not a silent replacement of today's product prompt. The API's existing
prompt now stabilizes connector discovery and duplicate skill ordering.

Research measurements and decisions live on PRA-78, PRA-96 and PRA-97 in Linear;
DeepAgents, LangChain and Supermemory were installed only in external scratch.
