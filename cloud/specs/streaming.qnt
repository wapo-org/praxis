// https://linear.app/praxis-a/issue/PRA-9: PRA-80 supersedes atomic replacement with Redis + durable Convex commit.
// https://linear.app/praxis-a/issue/PRA-28: reconnect deduplicates optimistic sends with clientTurnId.
// https://linear.app/praxis-a/issue/PRA-66: clients deduplicate final/live overlap by turn and attempt.
// Stop freezes worker-retained text, including unflushed tokens; a dead worker cannot commit its lost buffer.
module streaming {
  pure val CHUNKS_MAX = 5
  var s: {attempt: int, produced: List[int], chunks: List[int], committed: List[int], final: bool,
    stopped: bool, stopLength: int, alive: bool, starts: List[int], clientA: List[int], clientB: List[int]}
  action init = s' = {attempt: 0, produced: [], chunks: [], committed: [], final: false,
    stopped: false, stopLength: 0, alive: true, starts: [], clientA: [], clientB: []}
  action send(id) = s' = {...s, starts: if (s.starts.indices().exists(i => s.starts[i] == id)) s.starts else s.starts.append(id)}
  action flush(attempt, index) = all {
    s.alive, not(s.final), not(s.stopped), attempt == s.attempt,
    index == s.chunks.length(), index < s.produced.length(),
    s' = {...s, chunks: s.chunks.append(index)}
  }
  action produce = all {
    s.alive, not(s.final), not(s.stopped), s.produced.length() < CHUNKS_MAX,
    s' = {...s, produced: s.produced.append(s.produced.length())}
  }
  action retry = all {
    not(s.final), not(s.stopped),
    s' = {...s, attempt: s.attempt + 1, chunks: [], produced: [], alive: true}
  }
  action stop = all {
    s.alive, not(s.final), not(s.stopped),
    s' = {...s, stopped: true, stopLength: s.produced.length()}
  }
  action commit = all {
    s.alive,
    s' = if (s.final) s else {...s, committed: s.produced, final: true}
  }
  action cleanup = all {s.final, s' = {...s, chunks: []}}
  action crash = s' = {...s, alive: false}
  val visibleMessages = if (s.final) [s.committed] else if (s.chunks.length() > 0) [s.chunks] else []
  val visible = if (visibleMessages.length() > 0) visibleMessages[0] else []
  action step = {
    nondet index = 0.to(CHUNKS_MAX).oneOf()
    nondet attempt = 0.to(s.attempt + 1).oneOf()
    any {produce, send(index), flush(attempt, index), retry, stop, commit, cleanup, crash,
      s' = {...s, clientA: visible}, s' = {...s, clientB: visible}, s' = s}
  }
  val ClientTurnDedup = s.starts.length() == s.starts.indices().map(i => s.starts[i]).size()
  val FinalLiveDedup = visibleMessages.length() <= 1 and (not(s.final) or visibleMessages == [s.committed])
  val NoCommittedDrop = not(s.final) or s.committed == s.produced
  val OrderedPrefix = visible.indices().forall(i => visible[i] == i)
  val StopPrefix = not(s.stopped) or not(s.final) or s.committed.length() == s.stopLength
  val ReconnectCoherent = Set(s.clientA, s.clientB).forall(view =>
    view.indices().forall(i => view[i] == i))

  run stopPrefixTest = init.then(produce).then(produce).then(flush(0, 0)).then(stop).then(commit)
    .expect(StopPrefix and NoCommittedDrop and s.committed == [0, 1] and s.chunks == [0])
  run overlapCrashTest = init.then(produce).then(flush(0, 0)).then(commit).then(crash)
    .expect(FinalLiveDedup and s.chunks == [0] and s.committed == [0])
    .then(cleanup).expect(FinalLiveDedup and s.chunks == [])
  run duplicateCommitTest = init.then(produce).then(flush(0, 0)).then(commit).then(commit)
    .expect(FinalLiveDedup and s.committed == [0])
  run workerLossTest = init.then(produce).then(crash).then(retry).then(produce).then(commit)
    .expect(NoCommittedDrop and s.attempt == 1 and s.committed == [0])
  run deadWorkerCommitRejectedTest = init.then(produce).then(crash).then(commit).fail()
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
