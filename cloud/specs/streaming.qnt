// https://linear.app/praxis-a/issue/PRA-9: indexed deltas, attempt reset, atomic stream-to-message handoff.
// https://linear.app/praxis-a/issue/PRA-28: reconnect deduplicates optimistic sends with clientTurnId.
// https://linear.app/praxis-a/issue/PRA-66: Web and iOS read coherent subscription snapshots.
// Stop keeps the accepted prefix; delayed flushes and stale attempts cannot extend it.
module streaming {
  pure val CHUNKS_MAX = 5
  var s: {attempt: int, produced: List[int], chunks: List[int], committed: List[int], final: bool,
    stopped: bool, stopLength: int, starts: List[int], clientA: List[int], clientB: List[int]}
  action init = s' = {attempt: 0, produced: [], chunks: [], committed: [], final: false,
    stopped: false, stopLength: 0, starts: [], clientA: [], clientB: []}
  action send(id) = s' = {...s, starts: if (s.starts.indices().exists(i => s.starts[i] == id)) s.starts else s.starts.append(id)}
  action flush(attempt, index) = all {
    not(s.final), not(s.stopped), attempt == s.attempt,
    index == s.chunks.length(), index < s.produced.length(),
    s' = {...s, chunks: s.chunks.append(index)}
  }
  action produce = all {
    not(s.final), not(s.stopped), s.produced.length() < CHUNKS_MAX,
    s' = {...s, produced: s.produced.append(s.produced.length())}
  }
  action retry = all {
    not(s.final), not(s.stopped),
    s' = {...s, attempt: s.attempt + 1, chunks: [], produced: []}
  }
  action stop = all {
    not(s.final), not(s.stopped),
    s' = {...s, stopped: true, stopLength: s.chunks.length()}
  }
  action commit = all {
    not(s.final), s' = {...s, committed: if (s.stopped) s.chunks else s.produced, chunks: [], final: true}
  }
  val visible = if (s.final) s.committed else s.chunks
  action step = {
    nondet index = 0.to(CHUNKS_MAX).oneOf()
    nondet attempt = 0.to(s.attempt + 1).oneOf()
    any {produce, send(index), flush(attempt, index), retry, stop, commit,
      s' = {...s, clientA: visible}, s' = {...s, clientB: visible}, s' = s}
  }
  val ClientTurnDedup = s.starts.length() == s.starts.indices().map(i => s.starts[i]).size()
  val StreamCommitAtomic = not(s.final) or s.chunks.length() == 0
  val NoCommittedDrop = not(s.final) or s.stopped or s.committed == s.produced
  val OrderedPrefix = visible.indices().forall(i => visible[i] == i)
  val StopPrefix = not(s.stopped) or visible.length() == s.stopLength
  val ReconnectCoherent = Set(s.clientA, s.clientB).forall(view =>
    view.indices().forall(i => view[i] == i))

  run stopPrefixTest = init.then(produce).then(flush(0, 0)).then(stop).then(commit)
    .expect(StopPrefix and StreamCommitAtomic and s.committed == [0])
  run staleAttemptTest = init.then(produce).then(flush(0, 0)).then(retry)
    .then(produce).then(flush(1, 0))
    .then(commit).expect(OrderedPrefix and s.committed == [0])
  run stoppedFlushRejectedTest = init.then(stop).then(flush(0, 0)).fail()
  run staleFlushRejectedTest = init.then(retry).then(flush(0, 0)).fail()
  run gapRejectedTest = init.then(flush(0, 2)).fail()
  run unflushedCommitTest = init.then(produce).then(produce).then(flush(0, 0)).then(commit)
    .expect(NoCommittedDrop and s.committed == [0, 1])
  run dedupTest = init.then(send(1)).then(send(1)).expect(ClientTurnDedup and s.starts.length() == 1)
}
