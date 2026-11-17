/** PRA-22 pre-reservation core for platform-paid calls: pure, one ledger per user and period; persistence is PRA-22's job. */

/** Platform services only: OpenRouter is the user's own key, so it never reserves against the platform allowance. */
export type PlatformService = 'exa' | 'firecrawl' | 'modal';

export interface Reservation {
  /** Idempotency key chosen by the caller, e.g. `runId:callId:exa`; one reservation and one charge per key. */
  key: string;
  service: PlatformService;
  /** Worst-case cost reserved before the call, in integer micro-USD (1 USD = 1_000_000). */
  estimateMicroUsd: number;
  createdAtMs: number;
  /** Past this the reservation is an orphan: still held, because the provider may have billed it, until reconciliation. */
  expiresAtMs: number;
  orphaned: boolean;
}

export type ClosureKind = 'settled' | 'released';

export interface Closure {
  key: string;
  kind: ClosureKind;
  chargedMicroUsd: number;
  /** Closed after the TTL, by the reconciliation that settles or releases orphans. */
  late: boolean;
  atMs: number;
}

export interface Ledger {
  allowanceMicroUsd: number;
  /** Everything charged this period, including overruns: the ledger never under-reports money spent. */
  spentMicroUsd: number;
  /** Charged above a reservation's estimate: the only way spend can pass the allowance. */
  overrunMicroUsd: number;
  /** Open liabilities, live and orphaned alike; both count against the allowance. */
  reservations: Readonly<Record<string, Reservation>>;
  /** Every finished key, kept for the period so a retry can never reserve or charge it again. */
  closed: Readonly<Record<string, Closure>>;
}

export type ReserveOutcome =
  | {kind: 'reserved'; reservation: Reservation; replayed: boolean}
  | {kind: 'budget_exhausted'; availableMicroUsd: number; requestedMicroUsd: number}
  | {kind: 'orphaned'; reservation: Reservation}
  | {kind: 'closed'; closure: Closure};

export type SettleOutcome =
  | {kind: 'settled'; chargedMicroUsd: number; refundedMicroUsd: number; overrunMicroUsd: number; late: boolean}
  | {kind: 'duplicate'; closure: Closure}
  | {kind: 'unknown'};

export type ReleaseOutcome = {kind: 'released'; refundedMicroUsd: number; late: boolean} | {kind: 'duplicate'; closure: Closure} | {kind: 'unknown'};

export interface Step<O> {
  ledger: Ledger;
  outcome: O;
}

/** Keys come from callers, so `constructor` or `__proto__` must never resolve to an inherited property. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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

/** What a new reservation may still take: allowance minus spend minus every open liability, orphans included. */
export function availableMicroUsd(ledger: Ledger): number {
  return Math.max(0, ledger.allowanceMicroUsd - ledger.spentMicroUsd - reservedMicroUsd(ledger));
}

function close(ledger: Ledger, closure: Closure, spent: {charged: number; overrun: number}): Ledger {
  const reservations = {...ledger.reservations};
  delete reservations[closure.key];
  return {
    ...ledger,
    spentMicroUsd: ledger.spentMicroUsd + spent.charged,
    overrunMicroUsd: ledger.overrunMicroUsd + spent.overrun,
    reservations,
    closed: {...ledger.closed, [closure.key]: closure},
  };
}

/** Marks reservations past their TTL as orphans for the reconciliation cron; their money stays held until it settles them. */
export function expireOrphans(ledger: Ledger, nowMs: number): Step<{orphaned: string[]}> {
  const due = Object.values(ledger.reservations).filter(reservation => !reservation.orphaned && reservation.expiresAtMs <= nowMs);
  if (!due.length) return {ledger, outcome: {orphaned: []}};
  // fromEntries defines own properties, so even a `__proto__` key stays an ordinary entry.
  const reservations = Object.fromEntries(Object.entries(ledger.reservations).map(([key, reservation]) => [key, due.includes(reservation) ? {...reservation, orphaned: true} : reservation]));
  return {ledger: {...ledger, reservations}, outcome: {orphaned: due.map(reservation => reservation.key)}};
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
  const fresh = expireOrphans(ledger, input.nowMs).ledger;
  const existing = own(fresh.reservations, input.key);
  if (existing) return {ledger: fresh, outcome: existing.orphaned ? {kind: 'orphaned', reservation: existing} : {kind: 'reserved', reservation: existing, replayed: true}};
  const finished = own(fresh.closed, input.key);
  if (finished) return {ledger: fresh, outcome: {kind: 'closed', closure: finished}};
  const available = availableMicroUsd(fresh);
  if (input.estimateMicroUsd > available) return {ledger: fresh, outcome: {kind: 'budget_exhausted', availableMicroUsd: available, requestedMicroUsd: input.estimateMicroUsd}};
  const reservation: Reservation = {key: input.key, service: input.service, estimateMicroUsd: input.estimateMicroUsd, createdAtMs: input.nowMs, expiresAtMs: input.nowMs + input.ttlMs, orphaned: false};
  return {ledger: {...fresh, reservations: {...fresh.reservations, [input.key]: reservation}}, outcome: {kind: 'reserved', reservation, replayed: false}};
}

/** Charges the billed amount and refunds the rest, for a live call or an orphan the reconciliation priced from provider usage. */
export function settle(ledger: Ledger, input: {key: string; actualMicroUsd: number; nowMs: number}): Step<SettleOutcome> {
  assertMicroUsd(input.actualMicroUsd, 'actual cost');
  const reservation = own(ledger.reservations, input.key);
  if (!reservation) {
    const finished = own(ledger.closed, input.key);
    return {ledger, outcome: finished ? {kind: 'duplicate', closure: finished} : {kind: 'unknown'}};
  }
  const late = reservation.orphaned || reservation.expiresAtMs <= input.nowMs;
  const overrun = Math.max(0, input.actualMicroUsd - reservation.estimateMicroUsd);
  const closure: Closure = {key: input.key, kind: 'settled', chargedMicroUsd: input.actualMicroUsd, late, atMs: input.nowMs};
  return {
    ledger: close(ledger, closure, {charged: input.actualMicroUsd, overrun}),
    outcome: {kind: 'settled', chargedMicroUsd: input.actualMicroUsd, refundedMicroUsd: Math.max(0, reservation.estimateMicroUsd - input.actualMicroUsd), overrunMicroUsd: overrun, late},
  };
}

/** For a call the provider never billed (cancelled before dispatch, or reconciliation found no usage): all of it comes back. */
export function release(ledger: Ledger, input: {key: string; nowMs: number}): Step<ReleaseOutcome> {
  const reservation = own(ledger.reservations, input.key);
  if (!reservation) {
    const finished = own(ledger.closed, input.key);
    return {ledger, outcome: finished ? {kind: 'duplicate', closure: finished} : {kind: 'unknown'}};
  }
  const late = reservation.orphaned || reservation.expiresAtMs <= input.nowMs;
  const closure: Closure = {key: input.key, kind: 'released', chargedMicroUsd: 0, late, atMs: input.nowMs};
  return {ledger: close(ledger, closure, {charged: 0, overrun: 0}), outcome: {kind: 'released', refundedMicroUsd: reservation.estimateMicroUsd, late}};
}
