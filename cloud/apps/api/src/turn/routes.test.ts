import {inspect} from 'node:util';
import {REDACTED, SealedSecret} from '@praxis/types';
import {createHmac} from 'node:crypto';
import {Hono} from 'hono';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
 TURN_PATH, TURN_SIGNATURE_HEADER, TURN_TIMESTAMP_HEADER, TURN_CLOCK_SKEW_MS,
 TURN_BODY_MAX_BYTES, TURN_FAILURE_MESSAGE_MAX_BYTES, TurnRequestSchema, TurnResultSchema, SUBAGENT_LIMITS,
} from '@praxis/protocol';
import {ProviderFailure, runOneTurn} from '@praxis/agent';
import {fixture} from '../../../../packages/agent/src/one-turn-fixture.js';
import {createMemoryAdapters} from '../adapters/memory.js';
import {registerTurnRoute} from './routes.js';
import {readTurnKeys} from './auth.js';
import {TURN_CURRENT_KEY_ENV, TURN_NEXT_KEY_ENV, TURN_KEY_MIN_CHARACTERS} from './constants.js';

const NOW_MS = 1_800_000_000_000;
const rawKeys = {current: 'c'.repeat(TURN_KEY_MIN_CHARACTERS), next: 'n'.repeat(TURN_KEY_MIN_CHARACTERS)};
const keys = readTurnKeys({
 [TURN_CURRENT_KEY_ENV]: rawKeys.current, [TURN_NEXT_KEY_ENV]: rawKeys.next,
});
const input = {userId: 'owner', chatId: 'chat', runId: 'run', expectedTurnIndex: 0};
const flags = {done: false as const, status: 'ready' as const, turnIndex: 1, subagents: []};
function headers(body: string, timestamp = NOW_MS, key = rawKeys.current) {
 const time = String(timestamp);
 return {
  [TURN_TIMESTAMP_HEADER]: time,
  [TURN_SIGNATURE_HEADER]: createHmac('sha256', key).update(time).update('.').update(body).digest('hex'),
 };
}
function setup() {
 const adapters = createMemoryAdapters();
 const execute = vi.fn(async () => flags);
 adapters.turn = {execute};
 const cas = vi.spyOn(adapters.store, 'putIfRevision');
 const app = new Hono();
 registerTurnRoute(app, adapters, keys, () => NOW_MS);
 return {app, adapters, execute, cas};
}
const send = (app: Hono, body: string, credential: Record<string, string> = headers(body)) =>
 app.request(TURN_PATH, {method: 'POST', headers: credential, body});

describe('turn contract', () => {
 it('bounds requests, decisions, indexes and result flags', () => {
  expect(TurnRequestSchema.parse(input)).toEqual(input);
  for (const decision of [
   {type: 'approval.decision', approvalId: 'a', decision: 'deny'},
   {type: 'elicitation.response', elicitationId: 'e', action: 'cancel'},
  ]) expect(TurnRequestSchema.safeParse({...input, decision}).success).toBe(true);
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
   expect(TurnRequestSchema.safeParse({...input, expectedTurnIndex: value}).success).toBe(false);
  }
  expect(TurnRequestSchema.safeParse({...input, ownerId: 'other'}).success).toBe(false);
  expect(TurnResultSchema.parse(flags)).toEqual(flags);
  expect(TurnResultSchema.parse({...flags, done: true, status: 'completed'})).toBeTruthy();
  for (const value of [
   {...flags, done: true}, {...flags, status: 'completed'}, {...flags, message: 'private'},
   {...flags, subagents: ['same', 'same']},
   {...flags, subagents: ['\u0000'.repeat(200)]},
   {...flags, subagents: Array.from({length: SUBAGENT_LIMITS.CHILDREN_MAX + 1}, (_, i) => String(i))},
  ]) expect(TurnResultSchema.safeParse(value).success).toBe(false);
 });
 it('carries a bounded failure for a revoked key or spent credit, and nothing looser', () => {
  // Three-byte characters: the cap counts serialized UTF-8 bytes, not characters.
  const failure = {code: 'model_credit_exhausted', message: '余'.repeat(Math.floor(TURN_FAILURE_MESSAGE_MAX_BYTES / 3)), remediation: 'Add credit to your OpenRouter account, then send the message again.'};
  const failed = {...flags, done: true, status: 'failed', failure};
  expect(TurnResultSchema.parse(failed)).toEqual(failed);
  for (const value of [
   {...failed, failure: undefined}, {...failed, done: false}, {...flags, done: true, status: 'completed', failure},
   {...failed, failure: {...failure, message: '余'.repeat(Math.floor(TURN_FAILURE_MESSAGE_MAX_BYTES / 3) + 1)}},
   {...failed, failure: {...failure, code: 'model_unavailable'}},
  ]) expect(TurnResultSchema.safeParse(value).success).toBe(false);
 });
 it('answers a 402 with a long CJK message and four maximal child IDs as a failed 200, on delivery and redelivery', async () => {
  const turn = await fixture(true);
  turn.provider.stream = async function* () {
   throw new ProviderFailure('creditExhausted', '余额不足'.repeat(80), {status: 402});
  };
  const subagents = Array.from({length: SUBAGENT_LIMITS.CHILDREN_MAX}, (_, index) =>
   String(index) + 'a'.repeat(SUBAGENT_LIMITS.ID_MAX_CHARACTERS - 1));
  const {app, adapters} = setup();
  adapters.turn = {async execute(request) {
   const result = await runOneTurn({...turn, runId: request.runId, expectedTurnIndex: request.expectedTurnIndex});
   return {...result, subagents};
  }};
  const body = JSON.stringify(input);
  for (const offset of [0, 1]) {
   const response = await send(app, body, headers(body, NOW_MS + offset));
   expect(response.status).toBe(200);
   expect(await response.json()).toMatchObject({done: true, status: 'failed', turnIndex: 0, failure: {code: 'model_credit_exhausted'}});
  }
  expect(turn.store.data.response).toBeUndefined();
 });
 it('uses PRA-79 child ID syntax and bounds for compact scheduler references', () => {
  const subagents = Array.from({length: SUBAGENT_LIMITS.CHILDREN_MAX}, (_, index) =>
   String(index) + 'a'.repeat(SUBAGENT_LIMITS.ID_MAX_CHARACTERS - 1));
  expect(TurnResultSchema.parse({...flags, subagents}).subagents).toEqual(subagents);
  for (const id of ['child/path', 'child.id', 'a'.repeat(SUBAGENT_LIMITS.ID_MAX_CHARACTERS + 1)]) {
   expect(TurnResultSchema.safeParse({...flags, subagents: [id]}).success).toBe(false);
  }
 });
 it('validates required current and optional rotation keys', () => {
  expect(() => readTurnKeys({})).toThrow(TURN_CURRENT_KEY_ENV);
  expect(() => readTurnKeys({[TURN_CURRENT_KEY_ENV]: rawKeys.current, [TURN_NEXT_KEY_ENV]: 'short'})).toThrow(TURN_NEXT_KEY_ENV);
  const currentOnly = readTurnKeys({[TURN_CURRENT_KEY_ENV]: rawKeys.current});
  expect(currentOnly.current).toBeInstanceOf(SealedSecret);
  expect(currentOnly.next).toBeUndefined();
 });
 it('redacts both validated signing keys during serialization and inspection', () => {
  expect(keys.current).toBeInstanceOf(SealedSecret);
  expect(keys.next).toBeInstanceOf(SealedSecret);
  const serialized = JSON.stringify(keys);
  expect(JSON.parse(serialized)).toEqual({current: REDACTED, next: REDACTED});
  const inspected = inspect(keys, {depth: null, showHidden: true, getters: true});
  for (const output of [serialized, inspected]) {
   expect(output).toContain(REDACTED);
   expect(output).not.toContain(rawKeys.current);
   expect(output).not.toContain(rawKeys.next);
  }
 });
});

describe('Convex-only turn route', () => {
 it('accepts either signing key and binds the owner to the signed payload', async () => {
  for (const key of [rawKeys.current, rawKeys.next]) {
   const {app, execute, cas} = setup();
   const body = JSON.stringify(input);
   expect((await send(app, body, headers(body, NOW_MS, key))).status).toBe(200);
   expect(execute).toHaveBeenCalledExactlyOnceWith(input);
   expect(cas.mock.calls[0]?.[0]).toBe(input.userId);
  }
 });
 it('rejects forged, expired, future, altered and browser-only credentials without storage access', async () => {
  const {app, execute, cas} = setup();
  const body = JSON.stringify(input);
  const credentials: Record<string, string>[] = [
   {}, {cookie: 'praxis_session=dev-local', authorization: 'Bearer dev-local'},
   headers(body, NOW_MS, 'forged'), headers(body, NOW_MS - TURN_CLOCK_SKEW_MS - 1),
   headers(body, NOW_MS + TURN_CLOCK_SKEW_MS + 1),
   {...headers(body), [TURN_TIMESTAMP_HEADER]: String(NOW_MS + 1)},
   {...headers(body), [TURN_SIGNATURE_HEADER]: 'f'},
  ];
  for (const credential of credentials) expect((await send(app, body, credential)).status).toBe(401);
  expect((await send(app, JSON.stringify({...input, userId: 'victim'}), headers(body))).status).toBe(401);
  expect(cas).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
 });
 it('rejects concurrent replays across instances sharing durable adapters', async () => {
  const {app, adapters, execute} = setup();
  const second = new Hono();
  registerTurnRoute(second, adapters, keys, () => NOW_MS);
  const body = JSON.stringify(input);
  const results = await Promise.all([send(app, body), send(second, body)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 401]);
  expect((await send(app, body)).status).toBe(401);
  expect(execute).toHaveBeenCalledTimes(1);
 });
 it('returns 405 and checks missing authentication without reading request bodies', async () => {
  const {app} = setup();
  for (const method of ['PUT', 'POST']) {
   const request = new Request('http://localhost' + TURN_PATH, {method, body: '{}'});
   const read = vi.spyOn(request.body!, 'getReader');
   const response = await app.fetch(request);
   expect(response.status).toBe(method === 'PUT' ? 405 : 401);
   if (method === 'PUT') expect(response.headers.get('Allow')).toBe('POST');
   expect(read).not.toHaveBeenCalled();
  }
 });
 it('bounds streamed bytes and parses JSON only after signature verification', async () => {
  const {app, execute, cas} = setup();
  const body = 'x'.repeat(TURN_BODY_MAX_BYTES + 1);
  app.onError((error, c) => c.json({}, 'status' in error && error.status === 413 ? 413 : 500));
  expect((await send(app, body)).status).toBe(413);
  for (const value of ['{', JSON.stringify({...input, expectedTurnIndex: -1})]) {
   expect((await send(app, value)).status).toBe(400);
  }
  expect(cas).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
 });
 it('rechecks expiry after body transfer and accepts the exact skew boundary', async () => {
  const {adapters, execute} = setup();
  const app = new Hono();
  const clock = vi.fn().mockReturnValueOnce(NOW_MS).mockReturnValue(NOW_MS + TURN_CLOCK_SKEW_MS + 1);
  registerTurnRoute(app, adapters, keys, clock);
  const body = JSON.stringify(input);
  expect((await send(app, body)).status).toBe(401);
  expect(execute).not.toHaveBeenCalled();
  const boundary = setup();
  expect((await send(boundary.app, body, headers(body, NOW_MS - TURN_CLOCK_SKEW_MS))).status).toBe(200);
 });
 it('fails closed for missing adapters, receipt failures, upstream failures and malformed results', async () => {
  const {app, adapters, cas, execute} = setup();
  const body = JSON.stringify(input);
  cas.mockRejectedValueOnce(new Error('database unavailable'));
  expect((await send(app, body)).status).toBe(503);
  execute.mockRejectedValueOnce(new Error('secret upstream details'));
  const response = await send(app, body);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('secret');
  execute.mockResolvedValueOnce({...flags, turnIndex: -1});
  expect((await send(app, body, headers(body, NOW_MS + 1))).status).toBe(503);
  delete adapters.turn;
  expect((await send(app, body, headers(body, NOW_MS + 2))).status).toBe(503);
  const unconfigured = new Hono();
  registerTurnRoute(unconfigured, adapters);
  expect((await send(unconfigured, body)).status).toBe(503);
 });
 it('preserves expectedTurnIndex idempotency across newly signed retry envelopes', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 2, max: 12}), async retries => {
   const turn = await fixture(true);
   const {app, adapters} = setup();
   adapters.turn = {async execute(request) {
    const result = await runOneTurn({...turn, runId: request.runId, expectedTurnIndex: request.expectedTurnIndex});
    return {...result, subagents: []};
   }};
   const body = JSON.stringify(input);
   for (let i = 0; i < retries; i++) {
    expect((await send(app, body, headers(body, NOW_MS + i))).status).toBe(200);
   }
   expect(turn.counts.model).toBe(1);
   expect(turn.counts.tool).toBe(1);
   expect(turn.store.data.commits).toBe(1);
  }), {numRuns: 30});
 });
});
