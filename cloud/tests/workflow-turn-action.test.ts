import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  TURN_CURRENT_KEY_ENV, TURN_REQUEST_TIMEOUT_MS, TURN_RESULT_MAX_BYTES, TurnRequestSchema,
} from '@praxis/protocol';
import {api, internal} from '../convex/_generated/api.js';
import {TURN_WORKER_URL_ENV} from '../convex/workflows/constants.js';
import {SERVER_TOKEN, startedRun} from './workflow-fixture.js';
import {commitArgs, fakeTurnWorker, TURNS_TO_COMPLETE} from './workflow-worker.js';

const READY = {done: false, status: 'ready', subagents: [], turnIndex: 0};

async function setup() {
  const started = await startedRun();
  return {...started, worker: fakeTurnWorker(started.t), first: {...started.scope, expectedTurnIndex: 0}};
}

function rows(t: Awaited<ReturnType<typeof setup>>['t']) {
  return t.run(async ctx => ({
    turns: await ctx.db.query('turns').collect(),
    messages: await ctx.db.query('messages').collect(),
  }));
}

describe('turns.run against the signed /api/turn worker (PRA-30)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('makes one model call and writes one message when the same index runs twice', async () => {
    const {t, worker, first} = await setup();
    const flags = await t.action(internal.turns.run, first);
    expect(flags).toEqual(READY);
    expect(await t.action(internal.turns.run, first)).toEqual(flags);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.modelCalls).toHaveLength(1);
    expect((await rows(t)).messages).toHaveLength(1);
  });

  it('commits once when duplicate actions for one index overlap', async () => {
    const {t, runId, first} = await setup();
    const results = await Promise.all([t.action(internal.turns.run, first), t.action(internal.turns.run, first)]);
    expect(results).toEqual([READY, READY]);
    const {turns, messages} = await rows(t);
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect((await t.run(ctx => ctx.db.get(runId)))?.workflow?.nextTurnIndex).toBe(1);
  });

  it('signs every attempt with a fresh nonce and bounds it by the worker timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const {t, worker, first} = await setup();
    await t.action(internal.turns.run, first);
    await t.action(internal.turns.run, {...first, expectedTurnIndex: 1});
    const bodies = worker.fetch.mock.calls.map(([, init]) => TurnRequestSchema.parse(JSON.parse(String(init?.body))));
    expect(bodies.map(body => body.expectedTurnIndex)).toEqual([0, 1]);
    expect(new Set(bodies.map(body => body.nonce)).size).toBe(2);
    expect(timeout).toHaveBeenCalledWith(TURN_REQUEST_TIMEOUT_MS);
  });

  it('strips a worker payload beyond flags with a warning and keeps the result under 1 KB', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const {t, worker, first} = await setup();
    const transcript = 'private model output '.repeat(500);
    worker.reply.override = () => Response.json({...READY, transcript, usage: {inputTokens: 9}});
    const flags = await t.action(internal.turns.run, first);
    expect(flags).toEqual(READY);
    expect(new TextEncoder().encode(JSON.stringify(flags)).byteLength).toBeLessThan(TURN_RESULT_MAX_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('private');
  });

  it('fails the run without a model call when the worker rejects the signature', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const {t, worker, runId} = await setup();
    vi.stubEnv(TURN_CURRENT_KEY_ENV, 'a-different-signing-key-of-enough-length');
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({value: {status: 'failed'}, workflow: {nextTurnIndex: 0}});
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.modelCalls).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('throws on a worker 5xx or timeout so the step retries, then completes', async () => {
    const {t, worker, first, runId} = await setup();
    worker.reply.override = () => new Response('down', {status: 503});
    await expect(t.action(internal.turns.run, first)).rejects.toThrow('HTTP 503');
    worker.reply.override = () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    };
    await expect(t.action(internal.turns.run, first)).rejects.toThrow('timed out');
    let outages = 2;
    worker.reply.override = () => (outages-- > 0 ? new Response('down', {status: 502}) : undefined);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId)))
      .toMatchObject({value: {status: 'completed'}, workflow: {nextTurnIndex: TURNS_TO_COMPLETE}});
    expect(worker.modelCalls).toHaveLength(TURNS_TO_COMPLETE);
  });

  it('reads the saved flags on 409, and retries while none are saved', async () => {
    const {t, worker, first} = await setup();
    worker.reply.override = () => new Response(null, {status: 409});
    await expect(t.action(internal.turns.run, first)).rejects.toThrow('no flags are saved');
    await t.mutation(api.turns.commit, commitArgs(first));
    expect(await t.action(internal.turns.run, first)).toEqual(READY);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to dispatch without an https worker origin', async () => {
    const {t, worker, first} = await setup();
    vi.stubEnv(TURN_WORKER_URL_ENV, 'http://worker.test');
    await expect(t.action(internal.turns.run, first)).rejects.toThrow('not configured');
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});
