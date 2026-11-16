# Executable property contracts (PRA-75)

The models live in `cloud/specs/` so npm's pinned dev tools and CI use one
lockfile. They abstract transaction boundaries, not provider implementations.
Linear owns the implementation plans; these are test contracts.

Run `npm --prefix cloud run specs`: typecheck every model, run deterministic
Quint schedules, then simulate 500 traces of 80 transitions per model with
seed 75075. The TypeScript backend needs neither Java nor a downloaded native
simulator. Increase sample/depth/seed in `scripts/specs.mjs` for exploration.
ITF traces are written to ignored `cloud/.spec-traces/` and uploaded on CI failure.
Random simulation finds counterexamples; passing is not a proof or a liveness
claim. In particular eventual cancellation requires a fair worker/cron schedule.
Local full checking is optional: install Java and Apalache, then from `cloud/`
run `npx quint verify specs/security.qnt --invariant=AtomicSpendCap` (repeat for
each invariant). It is bounded checking, and is not part of CI.

| Model / named invariants | Existing executable property | Future implementation contract |
| --- | --- | --- |
| durable: TurnCommitOnce, CheckpointReplayStable | `packages/agent/src/checkpoint.property.test.ts`: stable outbox IDs, immutable checkpoint replay, no new terminal turn | PRA-30: concurrent expectedTurnIndex commits produce one ledger/message/usage row and the same stored flags; stale commits do nothing. The current runner has no expectedTurnIndex endpoint. |
| durable: HandoffBounded, HandoffSingleOwner, ResumeOnce, CancelFence | StopPrefix suite checks the existing cancellation fence | PRA-31/32: compressed threshold 4 represents production 40; two handoffs preserve contiguous indices; decisions persisted before wait resume once; Stop wins against wake and late commits. Children block handoff. |
| durable: RewindKeepsUsage; streaming: OrderedPrefix | API OrderedPrefix suite checks exact suffix deletion and contiguous new-message sequence | PRA-63: inactive rewind removes later turns, streams, approvals and descendants, retains usage; sandbox files/remote side effects are not rewound. Today's truncate cuts before a user message, not at an assistant turn. |
| streaming: ClientTurnDedup | API suite races starts, retries after completion, and rejects conflicting content | PRA-28/66: replay clientTurnId across Web/iOS reconnect; exactly one run/user message. |
| streaming: StreamCommitAtomic, NoCommittedDrop, OrderedPrefix, StopPrefix, ReconnectCoherent | API StopPrefix suite cancels at a generated chunk boundary, checks finished snapshot prefix and one terminal event | PRA-9: chunks accept only the next index of the current attempt; commit atomically replaces streams and includes unflushed producer text; Stop freezes the accepted prefix. Today's API retains partial blocks in the snapshot, not a durable truncated message. Client views may lag; reconnect must read an internally coherent authoritative snapshot. |
| subagents: NoOrphanRuns, NoOrphanHandles, CascadeStop, InboxExactlyOnce, TerminalCleanup | Quint deterministic tree/inbox/cleanup schedules | PRA-15/71/58: mutation tests must retry spawn by parent/call ID, enforce depth and tool subsets, stop descendants, reject late parent writes, dedup inbox IDs, and clean handles before terminal parent. Three nodes abstract a bounded recursive tree. Messaging IDs represent one message per recipient; no transport liveness is claimed. |
| security: TaintMonotonic, ApprovalRequired | Quint inherited/returned-taint and approval schedules | PRA-56/57: compaction is abstractly identity on security state; implementation must retain structural taint metadata, inherit on spawn and OR on result return; explicit approved receipts gate outbound side effects. Always-allow bypass for untainted runs is deliberately excluded from this stricter subprotocol. |
| security: AtomicSpendCap, ChargeOnce | Quint concurrent reservation and duplicate-settlement schedules | PRA-22: serializable reserve before launch, idempotent settle/release; actual cost must not exceed reserved upper bound. With that provider-enforced bound overspend is zero; an estimate alone cannot prove a cap. Model charges are user BYOK, this cap models platform services only. |
| credentials: OneRetryRound, NoSlotStarved, HealthyFailover | `packages/credentials/src/invariants.property.test.ts`: arbitrary cooling subsets, elapsed times, successful slot, full-failure exhaustion and recovery | NoSlotStarved means every eligible slot is reached if all earlier eligible slots fail, not round-robin allocation when earlier slots succeed. One request tries each eligible slot at most once; expiration restores eligibility on subsequent requests. |

No skipped/todo tests are added. The tests job runs all fast-check suites.
Models omit real time, byte/DB size, provider pricing, auth/tenant isolation,
network transport, file isolation and deployment behavior; their owning issues
still require integration tests. Deterministic schedules ensure handoff, retries,
cancel/wake, stale chunks, reservation contention and nested cleanup are exercised
even when random traces stop early.
