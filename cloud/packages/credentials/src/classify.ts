export type CooldownReason = 'invalid' | 'exhausted' | 'rateLimited' | 'serverError';

export type CredentialSignal = {kind: 'ok'} | {kind: CooldownReason; cooldownMs: number};

export type HeadersLike = {get(name: string): string | null} | Record<string, string | undefined>;

export const DEFAULT_COOLDOWNS_MS: Record<CooldownReason, number> = {
  invalid: 60 * 60_000,
  exhausted: 60 * 60_000,
  rateLimited: 60_000,
  serverError: 15_000,
};

export interface ClassifyOptions {
  now?: () => number;
  cooldownsMs?: Partial<Record<CooldownReason, number>>;
  /** Detects quota exhaustion on non-402 statuses. */
  quotaBody?: RegExp;
}

const QUOTA_BODY = /insufficient[_ ]quota|quota[_ ](?:exceeded|exhausted)|exceeded your (?:current )?quota|out of credits|insufficient[_ ](?:credits|balance|funds)/i;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

function header(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as {get?: unknown}).get === 'function') return (headers as {get(n: string): string | null}).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** Parses Retry-After seconds or HTTP-date into ms, clamped to [1 s, 1 h]; undefined when absent or unreadable. */
export function retryAfterMs(headers: HeadersLike | undefined, now: number): number | undefined {
  const raw = header(headers, 'retry-after')?.trim();
  if (!raw) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(Math.ceil(ms), 1000), MAX_RETRY_AFTER_MS);
}

/** Classifies HTTP statuses (401/403 invalid, 402 quota, 429 limit, 5xx cooldown). */
export function classifyHttp(status: number, headers?: HeadersLike, body?: string, options: ClassifyOptions = {}): CredentialSignal {
  const cool = {...DEFAULT_COOLDOWNS_MS, ...options.cooldownsMs};
  const quota = body !== undefined && (options.quotaBody ?? QUOTA_BODY).test(body);
  if (status === 402 || (quota && status >= 400)) return {kind: 'exhausted', cooldownMs: cool.exhausted};
  if (status === 401 || status === 403) return {kind: 'invalid', cooldownMs: cool.invalid};
  if (status === 429) return {kind: 'rateLimited', cooldownMs: retryAfterMs(headers, (options.now ?? Date.now)()) ?? cool.rateLimited};
  if (status >= 500 && status <= 599) return {kind: 'serverError', cooldownMs: cool.serverError};
  return {kind: 'ok'};
}
