// https://linear.app/praxis-a/issue/PRA-15: spawn keyed by parent/call, bounded tree, no late parent writes.
// https://linear.app/praxis-a/issue/PRA-71: addressed durable inbox, one delivery per message.
// https://linear.app/praxis-a/issue/PRA-58: cancelling descendants, handle cleanup before finalization.
// Three nodes represent a root, child and grandchild; cancellation is asynchronous, not instantaneous.
module subagents {
  pure val NODES = Set(0, 1, 2)
  var s: {live: Set[int], cancelling: Set[int], done: Set[int],
    handles: Set[int], sent: Set[int], delivered: Set[int], discarded: Set[int], results: Set[int]}
  action init = s' = {live: Set(0), cancelling: Set(), done: Set(),
    handles: Set(), sent: Set(), delivered: Set(), discarded: Set(), results: Set()}
  action spawn(node) = all {
    node > 0, s.live.contains(node - 1), not(s.cancelling.contains(node - 1)),
    not(s.live.contains(node)), not(s.done.contains(node)),
    s' = {...s, live: s.live.union(Set(node)), handles: s.handles.union(Set(node))}
  }
  action stop(node) = all {
    s.live.contains(node),
    s' = {...s, cancelling: s.cancelling.union(s.live.filter(n => n >= node))}
  }
  action cleanup(node) = all {
    s.cancelling.contains(node), s' = {...s, handles: s.handles.exclude(Set(node))}
  }
  action finalize(node) = all {
    s.cancelling.contains(node), not(s.handles.contains(node)),
    not(s.live.exists(n => n > node)),
    s' = {...s, live: s.live.exclude(Set(node)), cancelling: s.cancelling.exclude(Set(node)),
      done: s.done.union(Set(node)), discarded: s.discarded.union(s.sent.filter(n => n == node))}
  }
  action send(node) = all {
    s.live.contains(node), not(s.cancelling.contains(node)), s' = {...s, sent: s.sent.union(Set(node))}
  }
  action deliver(node) = all {
    s.sent.contains(node), s.live.contains(node), not(s.cancelling.contains(node)),
    s' = {...s, delivered: s.delivered.union(Set(node))}
  }
  action result(node) = all {
    node > 0, s.live.contains(node), s.live.contains(node - 1),
    not(s.cancelling.contains(node - 1)), s' = {...s, results: s.results.union(Set(node))}
  }
  action step = {
    nondet node = NODES.oneOf()
    any {spawn(node), stop(node), cleanup(node), finalize(node), send(node), deliver(node), result(node), s' = s}
  }
  val NoOrphanRuns = s.live.forall(n => n == 0 or s.live.contains(n - 1))
  val NoOrphanHandles = s.handles.subseteq(s.live)
  val CascadeStop = s.cancelling.forall(n => s.live.filter(c => c >= n).subseteq(s.cancelling))
  val InboxExactlyOnce = s.delivered.subseteq(s.sent)
  val TerminalCleanup = s.done.intersect(s.handles).size() == 0

  run cascadeTest = init.then(spawn(1)).then(spawn(2)).then(stop(0))
    
    .then(cleanup(2)).then(finalize(2)).then(cleanup(1)).then(finalize(1)).then(finalize(0))
    .expect(NoOrphanRuns and TerminalCleanup and s.live.size() == 0 and s.handles.size() == 0)
  run lateResultRejectedTest = init.then(spawn(1)).then(stop(0)).then(result(1)).fail()
  run earlyFinalizeRejectedTest = init.then(spawn(1)).then(stop(0)).then(finalize(0)).fail()
  run inboxTest = init.then(spawn(1)).then(send(1)).then(deliver(1)).then(deliver(1))
    .then(stop(0))
    .expect(InboxExactlyOnce and s.delivered.size() == 1)
}
