/** One observed fact inside a step; `observed` must never carry a token, password or code. */
export type Check = {name: string; ok: boolean; observed: string};

/** Shape B copies into proof.json: `status`/`summary` become the step outcome, `checks` the evidence. */
export type StepResult = {
  id: string;
  checklist: string;
  status: 'pass' | 'fail';
  summary: string;
  checks: Check[];
};

export const AUTH_REQUIRED = 'Authentication required';
export const CHAT_ID_UNAVAILABLE = 'Chat ID unavailable';
export const RUN_UNAVAILABLE = 'Run or chat unavailable';

export function check(name: string, ok: boolean, observed: string): Check {
  return {name, ok, observed};
}

export function stepResult(id: string, checklist: string, checks: Check[]): StepResult {
  const failed = checks.filter(item => !item.ok);
  if (checks.length === 0) return {id, checklist, status: 'fail', summary: 'no checks ran', checks};
  const summary = failed.length
    ? `failed: ${failed.map(item => item.name).join(', ')}`
    : `${checks.length} checks passed`;
  return {id, checklist, status: failed.length ? 'fail' : 'pass', summary, checks};
}

/** ConvexHttpClient forwards `ConvexError` payloads as `data`; plain errors only carry the message. */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error && typeof error.data === 'string') return error.data;
  return error instanceof Error ? error.message : String(error);
}

export function hasError(error: unknown, expected: string): boolean {
  return errorText(error).includes(expected);
}

export type Settled<T> = {ok: true; value: T} | {ok: false; error: unknown};

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return {ok: true, value: await promise};
  } catch (error) {
    return {ok: false, error};
  }
}

/** A foreign read passes when it returns nothing (null or an empty page) or the documented "unavailable" error. */
export function foreignReadCheck(name: string, result: Settled<unknown>): Check {
  if (!result.ok) {
    const text = errorText(result.error);
    const unavailable = /unavailable/i.test(text);
    return check(name, unavailable, unavailable ? `error: ${text}` : `unexpected error: ${text}`);
  }
  const value = result.value;
  if (value === null) return check(name, true, 'null');
  if (value === false) return check(name, true, 'false');
  if (isEmptyPage(value)) return check(name, true, 'empty page');
  return check(name, false, 'returned the other owner\'s row');
}

function isEmptyPage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'messages' in value
    && Array.isArray(value.messages) && value.messages.length === 0;
}

export function rejectedCheck(name: string, result: Settled<unknown>, expected: string): Check {
  if (result.ok) return check(name, false, 'call succeeded without the expected rejection');
  const text = errorText(result.error);
  return check(name, text.includes(expected), `error: ${text}`);
}

/** Sequences are strictly increasing by one; gaps or repeats mean the per-chat counter broke. */
export function contiguous(sequences: readonly (number | undefined)[]): boolean {
  if (sequences.length === 0) return false;
  return sequences.every((value, index) => {
    if (value === undefined) return false;
    const first = sequences[0];
    return first !== undefined && value === first + index;
  });
}
