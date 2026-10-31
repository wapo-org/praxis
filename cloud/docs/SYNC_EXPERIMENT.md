# Sync experiment: hash tree (Merkle) vs. revision cursor

**Verdict: cursor sync is the default. Merkle sync stays available behind `PRAXIS_SYNC_STRATEGY=merkle` (always on in local dev) as a repair path for replicas that lost or can't trust their cursor.**

## What was built
- `cloud/packages/sync` (`@praxis/sync`), portable to Swift:
  - `canonicalJSON` (sorted keys, no whitespace, UTF-8) and `contentHash` (SHA-256 hex over WebCrypto).
  - `bucketOf` (FNV-1a 32-bit over UTF-8 bytes) and `HashTree`: fan-out 16, depth 3 (4096 leaves). It is incremental, so only dirty paths are rehashed. Leaf and inner hashing rules are documented in `src/tree.ts`, with fixed test vectors in `src/sync.test.ts`.
  - `syncCursor` and `syncMerkle` clients over a `Transport`, with a `Replica` interface (IndexedDB on web, local persistence on iOS). `MemoryReplica` is the reference implementation.
  - `respondMerkle` (server side) and `SyncSimulator` (reference server for tests and the benchmark).
- API (`apps/api/src/sync-routes.ts`):
  - `GET|POST /v1/sync/pull` for cursor sync, reading the store's monotonic revision log (`Store.changes`).
  - `POST /v1/sync/tree`, plus `POST /v1/sync/pull` with `strategy:"merkle"`, for Merkle sync.
  - `GET /v1/sync/root`.
  - `bootstrap.syncCursor` = `Store.head(user)`.
  - Secrets and server-only rows (provider secrets, checkpoints, idempotency, outputs) never sync. The whitelist is `SYNC_KINDS`.

## Protocol
- **Cursor:** `{strategy:"cursor", cursor}` returns every entity revised after the cursor, including tombstones, deduplicated per key, in pages of up to 1000. The client applies each page transactionally and stores `cursor`. Revisions are monotonic integers, not wall-clock times, so simultaneous writes are never skipped.
- **Merkle:**
  1. The client sends `root`. If it is equal, sync is done.
  2. Otherwise the server returns the 16 children of the root.
  3. The client sends the prefixes whose hashes differ. A prefix shorter than the tree depth returns its 16 child nodes. A leaf prefix returns that leaf's live entities.
  4. The client replaces the differing leaves: it upserts entities whose hash changed and deletes local keys the leaf no longer has.

  This costs 1 + depth round trips when anything differs. It needs no cursor, and it returns a fresh `cursor` so the client can switch back to cursor sync.

## Benchmark
Run with `npm run bench -w @praxis/sync` (Node v26.7.0 on the dev machine, in-process, no network).
- Dataset: 1,000 chats + 50,000 messages (51,000 entities, about 400 bytes of text per message).
- k = changed messages since the replica last synced.
- Bytes are JSON request and response bodies only, with no HTTP framing or compression.
- "est. ms" adds RTT × round trips to the in-process compute time.

| k changes | strategy | round trips | request KB | response KB | total KB | compute ms | est. ms @50ms RTT | est. ms @150ms RTT |
|---|---|---|---|---|---|---|---|---|
| 0 | cursor | 1 | 0.1 | 0.1 | 0.2 | 1.5 | 51 | 151 |
| 0 | merkle | 1 | 0.1 | 0.2 | 0.3 | 0.2 | 50 | 150 |
| 1 | cursor | 1 | 0.1 | 0.8 | 0.8 | 2.3 | 52 | 152 |
| 1 | merkle | 4 | 0.3 | 14.8 | 15.1 | 0.8 | 201 | 601 |
| 50 | cursor | 1 | 0.1 | 32.8 | 32.9 | 1.6 | 52 | 152 |
| 50 | merkle | 4 | 0.9 | 533.6 | 534.5 | 12.3 | 212 | 612 |

A cold server-side tree build over the 51k entities takes 140 ms of compute, before the store reads.

## Why cursor wins here
- **Round trips.** Cursor sync is always 1 round trip (per 1000 changes). Merkle needs 4 whenever anything changed. On mobile, latency dominates, so Merkle is about 4× slower in wall time at k ≥ 1.
- **Bytes.** Merkle ships whole leaf buckets (about 12 rows each at 51k entities) plus 16-node fan-outs per level. At k = 50 that is 16× the bytes of cursor sync. Adding a "list leaf key+hash first" step would cut the bytes but add a fifth round trip.
- **Server cost.** Cursor sync is an indexed range read on the revision log. Merkle needs the owner's full entity-hash set: either a full scan (51k Convex reads per cold request) or a materialized per-user tree kept in sync on every write. A materialized tree is a few MB per heavy user, which is too large for one Redis value. The API keeps only a process-local tree cache keyed by head revision. That is fine for the flagged experiment, but not something to make default.
- **Where Merkle still wins.** Merkle is better when the client has no trustworthy cursor: a restored backup, a corrupted IndexedDB, a cursor older than retention, or verifying a replica after a bug. In those cases cursor sync must refetch everything. That is about 25 MB for this dataset, while Merkle only fetches the differing leaves. So clients can run a periodic or on-suspicion Merkle check (`GET /v1/sync/root`, then compare roots), and use cursor sync for the normal path.

## Flag
`PRAXIS_SYNC_STRATEGY` = `cursor` (the default) or `merkle`.
- With `merkle`, `/v1/sync/root` advertises `merkle` and returns the server root. `/v1/sync/tree` returns 404 unless the flag is set to `merkle`, in every environment, local included.
- Clients should follow `sync.root.strategy`.

## Known gaps
- No HTTP-level measurements (gzip would shrink Merkle's hex-heavy node lists by about 2×; the ranking doesn't change).
- The production server tree cache is per-instance memory. A durable materialized tree is left undone on purpose (see Server cost).
- The Swift port of `@praxis/sync` belongs to C. The test vectors in `packages/sync/src/sync.test.ts` are the conformance check.
