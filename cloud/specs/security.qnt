// https://linear.app/praxis-a/issue/PRA-56: side effects require structural approval.
// https://linear.app/praxis-a/issue/PRA-57: taint survives compaction and flows across spawn/return.
// https://linear.app/praxis-a/issue/PRA-22: reserve maximum platform cost atomically before fan-out.
// Settlement assumes actual <= reserved maximum; no finite overspend bound exists without that provider bound.
module security {
  pure val CALLS = Set(0, 1, 2)
  pure val BUDGET_UNITS_MAX = 10
  pure val CALL_COST_UNITS_MAX = 4
  var s: {tainted: Set[int], everTainted: Set[int], children: Set[int],
    reserved: Set[int], settled: Set[int], spent: int, approved: Set[int], executed: Set[int]}
  action init = s' = {tainted: Set(), everTainted: Set(), children: Set(),
    reserved: Set(), settled: Set(), spent: 0, approved: Set(), executed: Set()}
  action read(node) = s' = {...s, tainted: s.tainted.union(Set(node)), everTainted: s.everTainted.union(Set(node))}
  action spawn(node) = all {
    node > 0, not(s.children.contains(node)),
    s' = {...s, children: s.children.union(Set(node)),
      tainted: if (s.tainted.contains(0)) s.tainted.union(Set(node)) else s.tainted,
      everTainted: if (s.tainted.contains(0)) s.everTainted.union(Set(node)) else s.everTainted}
  }
  action childReturn(node) = all {
    s.children.contains(node),
    s' = {...s, tainted: if (s.tainted.contains(node)) s.tainted.union(Set(0)) else s.tainted,
      everTainted: if (s.tainted.contains(node)) s.everTainted.union(Set(0)) else s.everTainted}
  }
  action reserve(call) = all {
    not(s.settled.contains(call)), not(s.reserved.contains(call)),
    s.spent + (s.reserved.size() + 1) * CALL_COST_UNITS_MAX <= BUDGET_UNITS_MAX,
    s' = {...s, reserved: s.reserved.union(Set(call))}
  }
  action settle(call, actual) = all {
    s.reserved.contains(call), actual <= CALL_COST_UNITS_MAX,
    s' = {...s, reserved: s.reserved.exclude(Set(call)),
      settled: s.settled.union(Set(call)), spent: s.spent + actual}
  }
  action approve(call) = s' = {...s, approved: s.approved.union(Set(call))}
  action execute(call) = all {
    s.approved.contains(call), s' = {...s, executed: s.executed.union(Set(call))}
  }
  action step = {
    nondet call = CALLS.oneOf()
    nondet actual = 0.to(CALL_COST_UNITS_MAX).oneOf()
    any {read(call), spawn(call), childReturn(call), reserve(call), settle(call, actual),
      approve(call), execute(call), s' = s}
  }
  val TaintMonotonic = s.everTainted.subseteq(s.tainted)
  val AtomicSpendCap = s.spent + s.reserved.size() * CALL_COST_UNITS_MAX <= BUDGET_UNITS_MAX
  val ChargeOnce = s.settled.intersect(s.reserved).size() == 0
  val ApprovalRequired = s.executed.subseteq(s.approved)

  run inheritedTaintTest = init.then(read(0)).then(spawn(1)).then(s' = s).then(childReturn(1))
    .expect(TaintMonotonic and s.tainted == Set(0, 1))
  run returnedTaintTest = init.then(spawn(1)).then(read(1)).then(childReturn(1))
    .expect(TaintMonotonic and s.tainted.contains(0))
  run spendRaceTest = init.then(reserve(0)).then(reserve(1))
    .then(settle(0, 4)).then(settle(1, 4))
    .expect(AtomicSpendCap and ChargeOnce and s.spent == 8)
  run overspendRejectedTest = init.then(reserve(0)).then(reserve(1)).then(reserve(2)).fail()
  run doubleChargeRejectedTest = init.then(reserve(0)).then(settle(0, 4)).then(settle(0, 4)).fail()
  run unapprovedRejectedTest = init.then(execute(0)).fail()
  run approvalTest = init.then(read(0)).then(approve(0)).then(execute(0))
    .expect(ApprovalRequired)
}
