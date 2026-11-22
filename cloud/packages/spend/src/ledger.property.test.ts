import assert from 'node:assert/strict';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {availableMicroUsd, expireOrphans, openLedger, release, reserve, reservedMicroUsd, settle, type Ledger, type PlatformService} from './ledger.js';

/** Same scale idea as PRA-75 `security.qnt` (BUDGET_UNITS_MAX 10, CALL_COST_UNITS_MAX 4), in micro-USD. */
const ALLOWANCE_MICRO_USD = 10_000;
const CALL_ESTIMATE_MAX_MICRO_USD = 4_000;
const TTL_MS = 1_000;
const RUNS = 1_000;
const ATOMIC_SPEND_CAP_SEED = 75;

type Ending = 'settle' | 'release' | 'abandon';
interface Call {
  service: PlatformService;
  estimate: number;
  /** Fraction of the estimate actually billed; capped at 1 when the provider enforces the reservation's limit. */
  billed: number;
  ending: Ending;
  /** How many times the ending is replayed, as a retried mutation would. */
  repeats: number;
}

const call = (overrun: boolean) => fc.record({
  service: fc.constantFrom<PlatformService>('exa', 'firecrawl', 'modal'),
  estimate: fc.integer({min: 1, max: CALL_ESTIMATE_MAX_MICRO_USD}),
  billed: overrun ? fc.double({min: 0, max: 3, noNaN: true}) : fc.double({min: 0, max: 1, noNaN: true}),
  ending: fc.constantFrom<Ending>('settle', 'release', 'abandon'),
  repeats: fc.integer({min: 1, max: 3}),
});

/** Time between commits; gaps up to most of a TTL, so many schedules settle calls after their reservation expired. */
const GAP_MAX_MS = 700;

/** One committed mutation: an agent's next op, after a time gap, sometimes preceded by the orphan cron. */
interface Tick {
  agent: number;
  gapMs: number;
  cron: boolean;
}

/** Parallel sub-agents, each a sequence of calls, plus an interleaving: the order mutations commit in Convex. */
const workload = (overrun: boolean) => fc.array(fc.array(call(overrun), {minLength: 1, maxLength: 5}), {minLength: 2, maxLength: 6}).chain(agents => {
  const steps = agents.reduce((sum, calls) => sum + calls.length * 4, 0);
  const tick = fc.record({agent: fc.nat({max: agents.length - 1}), gapMs: fc.integer({min: 1, max: GAP_MAX_MS}), cron: fc.boolean()});
  return fc.tuple(fc.constant(agents), fc.array(tick, {minLength: steps, maxLength: steps}));
});

type Op = (ledger: Ledger, nowMs: number) => Ledger;

/** Each call becomes reserve, then (only if it got a reservation) its ending, replayed `repeats` times. */
function agentOps(agent: number, calls: readonly Call[]): Op[][] {
  return calls.map((spec, index) => {
    const key = `agent${agent}:call${index}`;
    let reserved = false;
    const actual = Math.floor(spec.estimate * spec.billed);
    const reserveOp: Op = (ledger, nowMs) => {
      const step = reserve(ledger, {key, service: spec.service, estimateMicroUsd: spec.estimate, nowMs, ttlMs: TTL_MS});
      reserved = step.outcome.kind === 'reserved';
      return step.ledger;
    };
    const endingOp: Op = (ledger, nowMs) => {
      if (!reserved || spec.ending === 'abandon') return ledger;
      return spec.ending === 'settle' ? settle(ledger, {key, actualMicroUsd: actual, nowMs}).ledger : release(ledger, {key, nowMs}).ledger;
    };
    return [reserveOp, ...Array.from({length: spec.repeats}, () => endingOp)];
  });
}

/** Applies ops one at a time in the generated order: each op is one serializable Convex mutation. */
function interleave(agents: readonly (readonly Call[])[], order: readonly Tick[], check: (ledger: Ledger) => void): Ledger {
  const queues = agents.map((calls, agent) => agentOps(agent, calls).flat());
  let ledger = openLedger(ALLOWANCE_MICRO_USD);
  let nowMs = 0;
  for (const tick of order) {
    const queue = queues[tick.agent]!.length ? queues[tick.agent]! : queues.find(q => q.length);
    if (!queue) break;
    nowMs += tick.gapMs;
    if (tick.cron) {
      ledger = expireOrphans(ledger, nowMs).ledger;
      check(ledger);
    }
    ledger = queue.shift()!(ledger, nowMs);
    check(ledger);
  }
  return ledger;
}

function chargeOnce(ledger: Ledger): void {
  assert.ok(!Object.keys(ledger.reservations).some(key => key in ledger.closed), 'A closed reservation is still open');
  const chargedMicroUsd = Object.values(ledger.closed).reduce((sum, closure) => sum + closure.chargedMicroUsd, 0);
  assert.equal(chargedMicroUsd, ledger.spentMicroUsd, 'Closed charges must match the ledger spend');
}

describe('PRA-75 security.qnt invariants on the real ledger', () => {
  it('AtomicSpendCap: parallel sub-agents never commit past the allowance when actual <= reserved, TTL expiry included', () => {
    fc.assert(fc.property(workload(false), ([agents, order]) => {
      interleave(agents, order, ledger => {
        assert.ok(ledger.spentMicroUsd + reservedMicroUsd(ledger) <= ALLOWANCE_MICRO_USD, 'Spend and reservations exceed the allowance');
        assert.equal(ledger.overrunMicroUsd, 0, 'A bounded provider cannot record an overrun');
        chargeOnce(ledger);
      });
    }), {numRuns: RUNS, seed: ATOMIC_SPEND_CAP_SEED});
  });

  it('stated bound: with overrunning providers, spend exceeds the allowance by at most the recorded overrun', () => {
    fc.assert(fc.property(workload(true), ([agents, order]) => {
      interleave(agents, order, ledger => {
        assert.ok(ledger.spentMicroUsd <= ALLOWANCE_MICRO_USD + ledger.overrunMicroUsd, 'Spend exceeds the allowance and recorded overrun');
        const committedMicroUsd = ledger.spentMicroUsd - ledger.overrunMicroUsd + reservedMicroUsd(ledger);
        assert.ok(committedMicroUsd <= ALLOWANCE_MICRO_USD, 'Overrun-adjusted spend and reservations exceed the allowance');
        chargeOnce(ledger);
      });
    }), {numRuns: RUNS});
  });

  it('ChargeOnce: settle and release are idempotent, whatever happened before', () => {
    fc.assert(fc.property(workload(true), fc.nat({max: 20}), fc.nat({max: 5_000}), ([agents, order], pick, actual) => {
      const ledger = interleave(agents, order, () => undefined);
      const keys = [...Object.keys(ledger.reservations), ...Object.keys(ledger.closed), 'missing'];
      const key = keys[pick % keys.length]!;
      const once = settle(ledger, {key, actualMicroUsd: actual, nowMs: 10_000}).ledger;
      expect(settle(once, {key, actualMicroUsd: actual, nowMs: 10_001}).ledger).toEqual(once);
      const released = release(ledger, {key, nowMs: 10_000}).ledger;
      expect(release(released, {key, nowMs: 10_001}).ledger).toEqual(released);
    }), {numRuns: RUNS});
  });

  it('TTL expiry marks exactly the due reservations as orphans and frees no money', () => {
    fc.assert(fc.property(fc.array(fc.record({estimate: fc.integer({min: 1, max: 2_000}), at: fc.nat({max: 3_000})}), {maxLength: 8}), fc.nat({max: 6_000}), (calls, nowMs) => {
      let ledger = openLedger(ALLOWANCE_MICRO_USD);
      calls.forEach((spec, index) => {
        ledger = reserve(ledger, {key: `k${index}`, service: 'modal', estimateMicroUsd: spec.estimate, nowMs: spec.at, ttlMs: TTL_MS}).ledger;
      });
      const due = Object.values(ledger.reservations).filter(reservation => !reservation.orphaned && reservation.expiresAtMs <= nowMs);
      const {ledger: after, outcome} = expireOrphans(ledger, nowMs);
      expect(outcome.orphaned.sort()).toEqual(due.map(reservation => reservation.key).sort());
      expect(Object.values(after.reservations).every(reservation => reservation.orphaned || reservation.expiresAtMs > nowMs)).toBe(true);
      expect(availableMicroUsd(after)).toBe(availableMicroUsd(ledger));
      expect(after.spentMicroUsd).toBe(ledger.spentMicroUsd);
    }), {numRuns: RUNS});
  });
});
