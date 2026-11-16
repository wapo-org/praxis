// https://linear.app/praxis-a/issue/PRA-7: durable flags, never replay committed turns.
// https://linear.app/praxis-a/issue/PRA-25: late results cannot leave cancelling.
// https://linear.app/praxis-a/issue/PRA-30: expectedTurnIndex CAS commits messages and flags together.
// https://linear.app/praxis-a/issue/PRA-31: one successor at a boundary, no pending children.
// https://linear.app/praxis-a/issue/PRA-32: persisted decisions survive early or duplicate events.
// https://linear.app/praxis-a/issue/PRA-63: inactive rewind keeps usage and removes later turns.
module durable {
  pure val HANDOFF_TURNS_MAX = 4
  pure val TURNS_MAX = 12
  var s: {head: int, ledger: List[int], usage: int, status: str,
    generation: int, boundary: int, decision: bool, resumes: int, children: bool, stopHead: int}

  action init = s' = {head: 0, ledger: [], usage: 0, status: "running",
    generation: 0, boundary: 0, decision: false, resumes: 0, children: false, stopHead: 0}
  action commit(expected) = all {
    s.status == "running", expected == s.head, s.head < TURNS_MAX,
    s.head - s.boundary < HANDOFF_TURNS_MAX,
    s' = {...s, head: s.head + 1, ledger: s.ledger.append(s.head), usage: s.usage + 1}
  }
  action handoff = all {
    s.status == "running", not(s.children), s.head - s.boundary == HANDOFF_TURNS_MAX,
    s' = {...s, generation: s.generation + 1, boundary: s.head}
  }
  action pause = all {s.status == "running", not(s.decision), s' = {...s, status: "paused"}}
  action answer = s' = {...s, decision: true}
  action wake = all {
    s.status == "paused", s.decision, s' = {...s, status: "running", resumes: s.resumes + 1}
  }
  action stop = all {
    Set("running", "paused").contains(s.status), s' = {...s, status: "cancelling", stopHead: s.head}
  }
  action finalize = all {s.status == "cancelling", s' = {...s, status: "cancelled", children: false}}
  action rewind(target) = all {
    s.status == "cancelled", target <= s.head,
    s' = {...s, head: target, ledger: s.ledger.slice(0, target)}
  }
  action step = {
    nondet index = 0.to(TURNS_MAX).oneOf()
    any {commit(index), handoff, pause, answer, wake, stop, finalize, rewind(index),
      all {s.status == "running", s' = {...s, children: not(s.children)}}, s' = s}
  }
  val TurnCommitOnce = s.ledger.length() == s.head and s.ledger.indices().forall(i => s.ledger[i] == i)
  val CheckpointReplayStable = s.usage >= s.head
  val HandoffBounded = s.status == "cancelled" or s.head - s.boundary <= HANDOFF_TURNS_MAX
  val ResumeOnce = s.resumes <= 1
  val RewindKeepsUsage = s.usage >= s.ledger.length()
  val HandoffSingleOwner = s.boundary == s.generation * HANDOFF_TURNS_MAX
  val CancelFence = (not(Set("cancelling", "cancelled").contains(s.status)) or s.head <= s.stopHead) and
    (s.status != "cancelled" or not(s.children))

  run handoffTest = init
    .then(commit(0)).then(commit(1)).then(commit(2)).then(commit(3)).then(handoff)
    .then(commit(4)).then(commit(5)).then(commit(6)).then(commit(7)).then(handoff)
    .then(commit(8)).then(commit(9)).then(commit(10)).then(commit(11))
    .expect(TurnCommitOnce and s.head == 12 and s.generation == 2)
  run stopWakeTest = init.then(pause).then(answer).then(stop)
    .then(finalize)
    .expect(CancelFence and s.resumes == 0)
  run duplicateCommitTest = init.then(commit(0))
    .expect(TurnCommitOnce and s.usage == 1)
  run stoppedWakeRejectedTest = init.then(pause).then(answer).then(stop).then(wake).fail()
  run duplicateRejectedTest = init.then(commit(0)).then(commit(0)).fail()
  run rewindTest = init.then(commit(0)).then(commit(1)).then(stop).then(finalize).then(rewind(1))
    .expect(TurnCommitOnce and RewindKeepsUsage and s.usage == 2 and s.head == 1)
}
