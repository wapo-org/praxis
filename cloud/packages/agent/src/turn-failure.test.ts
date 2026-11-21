import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  SUBAGENT_LIMITS, TURN_FAILURE_MESSAGE_MAX_BYTES, TURN_FAILURE_REMEDIATION_MAX_BYTES, TURN_RESULT_MAX_BYTES,
  TurnResultSchema, jsonStringBytes, type TurnFailure,
} from '@praxis/protocol';
import {ProviderFailure} from './provider-error.js';
import {runTurn} from './harness/turn.js';
import {turnFixture} from './harness/turn-fixture.js';
import {truncateJsonBytes, turnFailure} from './turn-failure.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const maxIds = Array.from({length: SUBAGENT_LIMITS.CHILDREN_MAX}, (_, i) => String(i) + 'a'.repeat(SUBAGENT_LIMITS.ID_MAX_CHARACTERS - 1));
const failed = (failure: TurnFailure, subagents: string[] = maxIds, turnIndex = Number.MAX_SAFE_INTEGER) =>
  ({turnIndex, subagents, done: true as const, status: 'failed' as const, failure});
/** No high surrogate without its low half, and no low surrogate without its high half. */
const wellFormed = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
const surrogateUnit = fc.integer({min: 0, max: 0xffff}).map(code => String.fromCharCode(code));
const anyText = (minLength = 0) => fc.oneof(
  fc.string({unit: 'binary', minLength, maxLength: 1500, size: 'max'}),
  fc.string({unit: surrogateUnit, minLength, maxLength: 1500, size: 'max'}),
  fc.string({unit: fc.constantFrom('余', '😀', '"', '\\', '\u0000', 'é', 'a'), minLength, maxLength: 1500, size: 'max'}),
);

describe('turn failure sizing', () => {
  it('keeps the reviewer case (CJK credit message, four maximal child IDs) under the result limit, on delivery and redelivery', async () => {
    const message = '余额不足'.repeat(80);
    const f = await turnFixture(() => ({error: {status: 402, message}}));
    for (const delivery of [1, 2]) {
      const run = await runTurn(f);
      expect(run.state, `delivery ${delivery}`).toBe('failed');
      if (run.state !== 'failed') continue;
      expect(message.startsWith(run.failure.message)).toBe(true);
      expect(jsonStringBytes(run.failure.message)).toBeLessThanOrEqual(TURN_FAILURE_MESSAGE_MAX_BYTES);
      const result = failed(run.failure);
      expect(TurnResultSchema.parse(result)).toEqual(result);
      expect(bytes(result)).toBeLessThan(TURN_RESULT_MAX_BYTES);
    }
    expect(f.ledger.saved).toBeUndefined();
  });

  it('derives the caps from the other fields at their maxima: escape-heavy text at both caps still fits', () => {
    const failure = {code: 'model_credit_exhausted' as const, message: '"'.repeat(TURN_FAILURE_MESSAGE_MAX_BYTES / 2), remediation: '\\'.repeat(TURN_FAILURE_REMEDIATION_MAX_BYTES / 2)};
    expect([jsonStringBytes(failure.message), jsonStringBytes(failure.remediation)]).toEqual([TURN_FAILURE_MESSAGE_MAX_BYTES, TURN_FAILURE_REMEDIATION_MAX_BYTES]);
    expect(bytes(failed(failure))).toBeLessThan(TURN_RESULT_MAX_BYTES);
    expect(TurnResultSchema.safeParse(failed(failure)).success).toBe(true);
    expect(TurnResultSchema.safeParse(failed({...failure, message: failure.message + '"'})).success).toBe(false);
  });

  it.each([
    ['emoji', '😀'.repeat(200)],
    ['emoji after an odd ASCII prefix', 'a' + '😀'.repeat(200)],
    ['emoji after three-byte text', '余'.repeat(5) + '😀'.repeat(200)],
  ])('cuts %s between code points, never inside a surrogate pair, and keeps as much as fits', (_name, text) => {
    const cut = truncateJsonBytes(text, TURN_FAILURE_MESSAGE_MAX_BYTES);
    expect(wellFormed(cut)).toBe(true);
    expect(text.startsWith(cut)).toBe(true);
    expect(jsonStringBytes(cut)).toBeLessThanOrEqual(TURN_FAILURE_MESSAGE_MAX_BYTES);
    const next = String.fromCodePoint(text.codePointAt(cut.length)!);
    expect(jsonStringBytes(cut + next)).toBeGreaterThan(TURN_FAILURE_MESSAGE_MAX_BYTES);
  });

  it('leaves a message that already fits untouched and passes other errors through', () => {
    expect(turnFailure(new ProviderFailure('keyInvalid', 'User not found.'))).toEqual({
      code: 'model_key_invalid', message: 'User not found.', remediation: expect.stringContaining('Reconnect OpenRouter'),
    });
    expect(turnFailure(new ProviderFailure('rateLimited', 'Slow down'))).toBeUndefined();
    expect(turnFailure(new Error('boom'))).toBeUndefined();
  });

  it('property: any failure message and remediation with any valid child-ID set parses and stays under the limit', () => {
    fc.assert(fc.property(
      anyText(), anyText(1),
      fc.constantFrom('keyInvalid' as const, 'creditExhausted' as const),
      fc.uniqueArray(fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, {size: 'max'}), {maxLength: SUBAGENT_LIMITS.CHILDREN_MAX, size: 'max'}),
      fc.maxSafeNat(),
      (message, remediation, kind, subagents, turnIndex) => {
        const failure = turnFailure(new ProviderFailure(kind, message, {remediation}))!;
        const result = failed(failure, subagents, turnIndex);
        expect(TurnResultSchema.safeParse(result).success).toBe(true);
        expect(bytes(result)).toBeLessThanOrEqual(TURN_RESULT_MAX_BYTES);
        expect(message.startsWith(failure.message)).toBe(true);
        if (wellFormed(message)) expect(wellFormed(failure.message)).toBe(true);
      },
    ), {numRuns: 500, seed: 42});
  });
});
