import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {internal} from '../convex/_generated/api.js';
import {LEDGER_KIND} from '../convex/agent/constants.js';
import {SERVER_TOKEN, startedRun} from './workflow-fixture.js';
import {fakeOpenRouter, TEST_MODEL_KEY, TURNS_TO_COMPLETE} from './workflow-model.js';

const READY = {done: false, status: 'ready', subagents: [], turnIndex: 0};

async function setup(sealKey = true) {
  const started = await startedRun();
  return {...started, model: await fakeOpenRouter(started.t, started.scope, undefined, sealKey), first: {...started.scope, expectedTurnIndex: 0}};
}

function rows(t: Awaited<ReturnType<typeof setup>>['t']) {
  return t.run(async ctx => ({
    turns: await ctx.db.query('turns').collect(),
    messages: await ctx.db.query('messages').collect(),
    ledger: await ctx.db.query('toolState').filter(q => q.eq(q.field('kind'), LEDGER_KIND)).collect(),
  }));
}

describe('turns.run runs the harness on the Convex Agent component (PRA-169)', () => {
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

  it('makes one model call with the unsealed key and commits once when the same index runs twice', async () => {
    const {t, model, first} = await setup();
    const flags = await t.action(internal.turns.run, first);
    expect(flags).toEqual(READY);
    expect(await t.action(internal.turns.run, first)).toEqual(flags);
    expect(model.modelCalls).toHaveLength(1);
    expect(model.modelCalls[0]!.authorization).toBe(`Bearer ${TEST_MODEL_KEY}`);
    const {messages, ledger} = await rows(t);
    expect(messages.map(message => message.value.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(ledger).toEqual([]);
  });

  it('commits once when duplicate actions for one index overlap', async () => {
    const {t, runId, first} = await setup();
    const results = await Promise.all([t.action(internal.turns.run, first), t.action(internal.turns.run, first)]);
    expect(results).toEqual([READY, READY]);
    const {turns, messages} = await rows(t);
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(3);
    expect((await t.run(ctx => ctx.db.get(runId)))?.workflow?.nextTurnIndex).toBe(1);
  });

  it('replays the committed response, reasoning signature included, on the next turn and stores usage', async () => {
    const {t, model, first} = await setup();
    await t.action(internal.turns.run, first);
    await t.action(internal.turns.run, {...first, expectedTurnIndex: 1});
    const messages = model.modelCalls[1]!.body.messages as Array<{role: string; reasoning_details?: unknown; tool_call_id?: string}>;
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(JSON.stringify(messages[2]!.reasoning_details)).toContain('sig-workflow');
    expect(messages[3]!.tool_call_id).toBe('call-0');
    const {turns} = await rows(t);
    expect(turns[0]).toMatchObject({usage: {inputTokens: 10, outputTokens: 2, cost: 0.0001}});
  });

  it('a saved response from a lost attempt is replayed instead of a second model call', async () => {
    const {t, model, first} = await setup();
    model.reply.override = () => {
      throw new Error('process lost after the response was saved');
    };
    await t.run(async ctx => {
      const encoded = JSON.stringify({content: [{type: 'text', text: 'saved answer'}], finishReason: {unified: 'stop'},
        usage: {inputTokens: {total: 1}, outputTokens: {total: 1}}});
      await ctx.db.insert('toolState', {userId: first.userId, kind: LEDGER_KIND, id: `${first.runId}/0/0/response`, value: {encoded}});
    });
    expect(await t.action(internal.turns.run, first)).toMatchObject({done: true, status: 'completed'});
    expect(model.modelCalls).toHaveLength(0);
    const {messages, ledger} = await rows(t);
    expect(messages.at(-1)?.value.parts).toEqual([{type: 'text', text: 'saved answer'}]);
    expect(ledger).toEqual([]);
  });

  it('fails the run with model_key_missing and no model call when no key is connected', async () => {
    const {t, model, runId} = await setup(false);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({
      value: {status: 'failed', errorCode: 'model_key_missing'}, workflow: {nextTurnIndex: 0},
    });
    expect(model.modelCalls).toHaveLength(0);
  });

  it('fails the run on a revoked key (401) without retrying', async () => {
    const {t, model, runId} = await setup();
    model.reply.override = () => Response.json({error: {code: 401, message: 'User not found.'}}, {status: 401});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({value: {status: 'failed', errorCode: 'model_key_invalid'}});
    expect(model.modelCalls).toHaveLength(1);
  });

  it('throws on a provider failure so the step retries, then completes', async () => {
    const {t, model, first, runId} = await setup();
    let failures = 1;
    model.reply.override = () => (failures-- > 0 ? Response.json({error: {code: 400, message: 'Bad request'}}, {status: 400}) : undefined);
    await expect(t.action(internal.turns.run, first)).rejects.toThrow('Bad request');
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId)))
      .toMatchObject({value: {status: 'completed'}, workflow: {nextTurnIndex: TURNS_TO_COMPLETE}});
    expect(model.modelCalls).toHaveLength(TURNS_TO_COMPLETE + 1);
  });

  it('offers no tools until Convex tool implementations land, and denies the call the model makes anyway', async () => {
    const {t, model, first} = await setup();
    await t.action(internal.turns.run, first);
    expect(model.modelCalls[0]!.body.tools).toBeUndefined();
    const {messages} = await rows(t);
    expect(messages.at(-1)?.value.parts).toMatchObject([{type: 'toolResult', callId: 'call-0', isError: true}]);
  });
});
