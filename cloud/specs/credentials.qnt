// @praxis/credentials/src/failover.ts: ordered single-pass retries, cooling slots are skipped.
// NoSlotStarved is conditional reachability, not round-robin fairness while earlier slots succeed.
module credentials {
  pure val SLOTS_MAX = 4
  pure val SLOTS = 1.to(SLOTS_MAX)
  var s: {next: int, attempts: List[int], cooling: Set[int], done: bool, winner: int}
  action init = {
    nondet cooling = SLOTS.powerset().oneOf()
    s' = {next: 1, attempts: [], cooling: cooling, done: false, winner: 0}
  }
  action skip = all {
    not(s.done), s.next <= SLOTS_MAX, s.cooling.contains(s.next), s' = {...s, next: s.next + 1}
  }
  action rejectSlot = all {
    not(s.done), s.next <= SLOTS_MAX, not(s.cooling.contains(s.next)),
    s' = {...s, next: s.next + 1, attempts: s.attempts.append(s.next)}
  }
  action succeed = all {
    not(s.done), s.next <= SLOTS_MAX, not(s.cooling.contains(s.next)),
    s' = {...s, done: true, winner: s.next, attempts: s.attempts.append(s.next)}
  }
  action exhaust = all {s.next > SLOTS_MAX, s' = {...s, done: true}}
  action step = any {skip, rejectSlot, succeed, exhaust, s' = s}
  val OneRetryRound = s.attempts.length() <= SLOTS_MAX and s.attempts.indices().map(i => s.attempts[i]).size() == s.attempts.length()
  val NoSlotStarved = s.winner != 0 or SLOTS.filter(n => n < s.next and not(s.cooling.contains(n))) == s.attempts.indices().map(i => s.attempts[i])
  val HealthyFailover = s.winner == 0 or not(s.cooling.contains(s.winner))
  run exhaustionTest = (s' = {next: 1, attempts: [], cooling: Set(2), done: false, winner: 0})
    .then(rejectSlot).then(skip).then(rejectSlot).then(rejectSlot).then(exhaust)
    .expect(OneRetryRound and NoSlotStarved and s.attempts == [1, 3, 4])
}
