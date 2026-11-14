import {classifyHttp, type CooldownReason, type CredentialSignal, type HeadersLike} from './classify.js';
import type {Cooldown, CooldownStore} from './cooldown.js';
import type {CredentialPool} from './pool.js';

export interface SlotState extends Cooldown {
  slot: number;
}

/** Slot numbers and the service name only. Never a credential. */
export type CredentialLogEvent =
  | {event: 'credential.cooldown'; service: string; slot: number; reason: CooldownReason; until: number}
  | {event: 'credential.unavailable'; service: string; slots: number[]; retryAt: number | null};
export type CredentialLog = (event: CredentialLogEvent) => void;

/** No slot of the service can serve the call right now. `retryAt` is the earliest moment one may again. */
export class CredentialsUnavailableError extends Error {
  readonly name = 'CredentialsUnavailableError';
  readonly retryAt: Date | null;
  constructor(readonly service: string, readonly slots: readonly SlotState[], readonly detail: 'cooling' | 'unconfigured' | 'missing' = 'cooling') {
    super(detail === 'cooling' ? `All credentials of ${service} are cooling down` : `No usable credential slot for ${service} (${detail})`);
    this.retryAt = slots.length ? new Date(Math.min(...slots.map(s => s.until))) : null;
  }
}

/** Thrown by `fn` to report an unavailable credential when there is no response value to classify. */
export class CredentialSignalError extends Error {
  readonly name = 'CredentialSignalError';
  constructor(readonly signal: Exclude<CredentialSignal, {kind: 'ok'}>) {
    super(`Credential unavailable: ${signal.kind}`);
  }
}

export interface WithCredentialOptions<T> {
  /** Reads the result of `fn`. Default: HTTP responses go through `classifyHttp`, anything else is `ok`. */
  classify?: (value: T) => CredentialSignal | Promise<CredentialSignal>;
  log?: CredentialLog;
  now?: () => number;
}

function defaultClassify(value: unknown, now: () => number): CredentialSignal {
  const response = value as {status?: unknown; headers?: HeadersLike} | null;
  if (response && typeof response === 'object' && typeof response.status === 'number') return classifyHttp(response.status, response.headers, undefined, {now});
  return {kind: 'ok'};
}

/**
 * Failover for stateless services: runs `fn` with the lowest-numbered healthy slot. On an unavailable signal
 * the slot is marked cooling and the next one is tried, each slot at most once. Returns the value and the slot
 * that served it. Other errors thrown by `fn` pass through unchanged. A store that fails is treated as "healthy".
 */
export async function withCredential<C, T>(pool: CredentialPool<C>, store: CooldownStore, fn: (credential: C, slot: number) => Promise<T>, options: WithCredentialOptions<T> = {}): Promise<{value: T; slot: number}> {
  const now = options.now ?? Date.now;
  if (!pool.slots.length) throw new CredentialsUnavailableError(pool.service, [], 'unconfigured');
  const cooling: SlotState[] = [];
  for (const {slot, credential} of pool.slots) {
    const current = await store.get(pool.service, slot).catch(() => null);
    if (current && current.until > now()) {
      cooling.push({slot, ...current});
      continue;
    }
    let signal: CredentialSignal;
    let value: T | undefined;
    try {
      value = await fn(credential, slot);
      signal = options.classify ? await options.classify(value) : defaultClassify(value, now);
    } catch (error) {
      if (!(error instanceof CredentialSignalError)) throw error;
      signal = error.signal;
    }
    if (signal.kind === 'ok') return {value: value as T, slot};
    const cooldown = {reason: signal.kind, until: now() + Math.max(1, signal.cooldownMs)};
    const created = await store.mark(pool.service, slot, cooldown).catch(() => false);
    if (created) options.log?.({event: 'credential.cooldown', service: pool.service, slot, ...cooldown});
    cooling.push({slot, ...cooldown});
  }
  const error = new CredentialsUnavailableError(pool.service, cooling);
  options.log?.({event: 'credential.unavailable', service: pool.service, slots: cooling.map(s => s.slot), retryAt: error.retryAt?.getTime() ?? null});
  throw error;
}
