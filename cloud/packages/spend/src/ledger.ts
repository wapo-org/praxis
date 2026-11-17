/** PRA-22 pre-reservation for platform-paid calls: pure, one ledger per user and period, one Convex mutation per call. */

/** Platform services only: OpenRouter is the user's own key, so it never reserves against the platform allowance. */
export type PlatformService = 'exa' | 'firecrawl' | 'modal';

export interface Reservation {
  /** Idempotency key chosen by the caller, e.g. `runId:callId:exa`; one reservation and one charge per key. */
  key: string;
  service: PlatformService;
  /** Worst-case cost reserved before the call, in integer micro-USD (1 USD = 1_000_000). */
  estimateMicroUsd: number;
  createdAtMs: number;
  /** After this the reservation is reclaimed; a settle that arrives later is still charged, as a late settlement. */
  expiresAtMs: number;
}

export type ClosureKind = 'settled' | 'released' | 'expired';

export interface Closure {
  key: string;
  kind: ClosureKind;
  chargedMicroUsd: number;
  /** A settle that arrived after the reservation expired; its whole charge counts as overrun. */
  late: boolean;
  atMs: number;
}

export interface Ledger {
  allowanceMicroUsd: number;
  /** Everything charged this period, including overruns: the ledger never under-reports money spent. */
  spentMicroUsd: number;
  /** Charged above the reservation (actual > estimate) plus late settlements; the only way spend can pass the allowance. */
  overrunMicroUsd: number;
  reservations: Readonly<Record<string, Reservation>>;
  /** Every finished key, kept for the period so a retry can never reserve or charge it again. */
  closed: Readonly<Record<string, Closure>>;
}

export type ReserveOutcome =
  | {kind: 'reserved'; reservation: Reservation; replayed: boolean}
  | {kind: 'budget_exhausted'; availableMicroUsd: number; requestedMicroUsd: number}
  | {kind: 'closed'; closure: Closure};

export type SettleOutcome =
  | {kind: 'settled'; chargedMicroUsd: number; refundedMicroUsd: number; overrunMicroUsd: number; late: boolean}
  | {kind: 'duplicate'; closure: Closure}
  | {kind: 'unknown'};

export type ReleaseOutcome = {kind: 'released'; refundedMicroUsd: number} | {kind: 'duplicate'; closure: Closure} | {kind: 'unknown'};

export interface Step<O> {
  ledger: Ledger;
  outcome: O;
}

export function openLedger(allowanceMicroUsd: number): Ledger {
  assertMicroUsd(allowanceMicroUsd, 'allowance');
  return {allowanceMicroUsd, spentMicroUsd: 0, overrunMicroUsd: 0, reservations: {}, closed: {}};
}

function assertMicroUsd(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer number of micro-USD, got ${value}`);
}

export function reservedMicroUsd(ledger: Ledger): number {
  return Object.values(ledger.reservations).reduce((sum, reservation) => sum + reservation.estimateMicroUsd, 0);
}

/** What a new reservation may still take: allowance minus spend minus everything reserved and not yet settled. */
export function availableMicroUsd(ledger: Ledger): number {
  return Math.max(0, ledger.allowanceMicroUsd - ledger.spentMicroUsd - reservedMicroUsd(ledger));
}

function close(ledger: Ledger, closure: Closure, spent: {charged: number; overrun: number}): Ledger {
  const {[closure.key]: _finished, ...reservations} = ledger.reservations;
  return {
    ...ledger,
    spentMicroUsd: ledger.spentMicroUsd + spent.charged,
    overrunMicroUsd: ledger.overrunMicroUsd + spent.overrun,
    reservations,
    closed: {...ledger.closed, [closure.key]: closure},
  };
}

/** Reclaims every reservation whose TTL has passed; the cron calls this, and reserve does it first so a full ledger frees itself. */
export function reclaimExpired(ledger: Ledger, nowMs: number): Step<{reclaimed: string[]}> {
  let next = ledger;
  const reclaimed: string[] = [];
  for (const reservation of Object.values(ledger.reservations)) {
    if (reservation.expiresAtMs > nowMs) continue;
    next = close(next, {key: reservation.key, kind: 'expired', chargedMicroUsd: 0, late: false, atMs: nowMs}, {charged: 0, overrun: 0});
    reclaimed.push(reservation.key);
  }
  return {ledger: next, outcome: {reclaimed}};
}

export interface ReserveInput {
  key: string;
  service: PlatformService;
  estimateMicroUsd: number;
  nowMs: number;
  ttlMs: number;
}

/** All or nothing: the full worst-case estimate is reserved, or the call must not start (`budget_exhausted`). */
export function reserve(ledger: Ledger, input: ReserveInput): Step<ReserveOutcome> {
  assertMicroUsd(input.estimateMicroUsd, 'estimate');
  if (!input.key) throw new RangeError('reservation key is empty');
  const existing = ledger.reservations[input.key];
  if (existing && existing.expiresAtMs > input.nowMs) return {ledger, outcome: {kind: 'reserved', reservation: existing, replayed: true}};
  const finished = ledger.closed[input.key];
  if (finished) return {ledger, outcome: {kind: 'closed', closure: finished}};
  const {ledger: fresh} = reclaimExpired(ledger, input.nowMs);
  const reclaimedSelf = fresh.closed[input.key];
  if (reclaimedSelf) return {ledger: fresh, outcome: {kind: 'closed', closure: reclaimedSelf}};
  const available = availableMicroUsd(fresh);
  if (input.estimateMicroUsd > available) return {ledger: fresh, outcome: {kind: 'budget_exhausted', availableMicroUsd: available, requestedMicroUsd: input.estimateMicroUsd}};
  const reservation: Reservation = {key: input.key, service: input.service, estimateMicroUsd: input.estimateMicroUsd, createdAtMs: input.nowMs, expiresAtMs: input.nowMs + input.ttlMs};
  return {ledger: {...fresh, reservations: {...fresh.reservations, [input.key]: reservation}}, outcome: {kind: 'reserved', reservation, replayed: false}};
}

/** Charges the billed amount and refunds the rest; callers cap the call at its reservation, so overrun stays zero. */
export function settle(ledger: Ledger, input: {key: string; actualMicroUsd: number; nowMs: number}): Step<SettleOutcome> {
  assertMicroUsd(input.actualMicroUsd, 'actual cost');
  const reservation = ledger.reservations[input.key];
  const finished = ledger.closed[input.key];
  if (reservation) {
    const overrun = Math.max(0, input.actualMicroUsd - reservation.estimateMicroUsd);
    const closure: Closure = {key: input.key, kind: 'settled', chargedMicroUsd: input.actualMicroUsd, late: false, atMs: input.nowMs};
    return {
      ledger: close(ledger, closure, {charged: input.actualMicroUsd, overrun}),
      outcome: {kind: 'settled', chargedMicroUsd: input.actualMicroUsd, refundedMicroUsd: Math.max(0, reservation.estimateMicroUsd - input.actualMicroUsd), overrunMicroUsd: overrun, late: false},
    };
  }
  if (finished?.kind === 'expired') {
    // The provider did bill it, so the ledger records it; the reservation it relied on was already given back.
    const closure: Closure = {key: input.key, kind: 'settled', chargedMicroUsd: input.actualMicroUsd, late: true, atMs: input.nowMs};
    return {
      ledger: {...ledger, spentMicroUsd: ledger.spentMicroUsd + input.actualMicroUsd, overrunMicroUsd: ledger.overrunMicroUsd + input.actualMicroUsd, closed: {...ledger.closed, [input.key]: closure}},
      outcome: {kind: 'settled', chargedMicroUsd: input.actualMicroUsd, refundedMicroUsd: 0, overrunMicroUsd: input.actualMicroUsd, late: true},
    };
  }
  if (finished) return {ledger, outcome: {kind: 'duplicate', closure: finished}};
  return {ledger, outcome: {kind: 'unknown'}};
}

/** For a call that never reached the provider (cancelled, refused before dispatch): the whole reservation comes back. */
export function release(ledger: Ledger, input: {key: string; nowMs: number}): Step<ReleaseOutcome> {
  const reservation = ledger.reservations[input.key];
  if (reservation) {
    const closure: Closure = {key: input.key, kind: 'released', chargedMicroUsd: 0, late: false, atMs: input.nowMs};
    return {ledger: close(ledger, closure, {charged: 0, overrun: 0}), outcome: {kind: 'released', refundedMicroUsd: reservation.estimateMicroUsd}};
  }
  const finished = ledger.closed[input.key];
  return finished ? {ledger, outcome: {kind: 'duplicate', closure: finished}} : {ledger, outcome: {kind: 'unknown'}};
}
