import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Message} from '@praxis/protocol';
import {api, internal} from '../convex/_generated/api.js';
import {SERVER_TOKEN, startedRun} from './workflow-fixture.js';
import {assistantMessage, commitArgs} from './workflow-worker.js';

const NOW = '2026-11-20T00:00:00.000Z';
const TAINT = {tainted: true as const, source: 'Gmail', callId: 'call-1'};
const TAINTED_RESULT: Message['parts'] = [{type: 'toolResult', callId: 'call-1', content: [], taintSource: 'Gmail'}];

async function setup() {
  const started = await startedRun();
  const first = {...started.scope, expectedTurnIndex: 0};
  const snapshot = () => started.t.run(async ctx => ({
    turns: await ctx.db.query('turns').collect(),
    messages: await ctx.db.query('messages').collect(),
    changes: await ctx.db.query('changes').collect(),
    run: await ctx.db.get(started.runId),
  }));
  return {...started, first, snapshot};
}

describe('turns.commit fence (PRA-30)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('writes messages, usage, receipt and cursor together, and a stale index or generation writes nothing', async () => {
    const {t, first, runId, snapshot} = await setup();
    const usage = {type: 'usage' as const, inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.002};
    const committed = await t.mutation(api.turns.commit, commitArgs(first, {end: {status: 'ready'}, usage,
      messages: [assistantMessage(first)]}));
    expect(committed).toEqual({outcome: 'committed', flags: {done: false, status: 'ready', subagents: [], turnIndex: 0}});
    const after = await snapshot();
    expect(after.turns).toMatchObject([{turnIndex: 0, status: 'ready', usage: {inputTokens: 120, outputTokens: 30, cost: 0.002}}]);
    expect(after.turns[0]?.usage).not.toHaveProperty('type');
    expect(after.messages).toMatchObject([{sequence: 1, value: {role: 'assistant', runId}}]);
    expect(after.changes.filter(change => change.kind === 'message')).toHaveLength(1);
    expect(after.run?.workflow?.nextTurnIndex).toBe(1);
    for (const stale of [first, {...first, expectedTurnIndex: 3}, {...first, expectedTurnIndex: 1, generation: 1}]) {
      const fresh = assistantMessage({...stale, expectedTurnIndex: 9});
      expect(await t.mutation(api.turns.commit, commitArgs(stale, {end: {status: 'completed'}, messages: [fresh]})))
        .toEqual({outcome: 'conflict'});
    }
    expect(await snapshot()).toEqual(after);
  });

  it('rolls back a commit whose messages are not new assistant messages of its run', async () => {
    const {t, first, snapshot} = await setup();
    const before = await snapshot();
    const own = assistantMessage(first);
    for (const message of [{...own, role: 'user' as const}, {...own, chatId: 'other-chat'}, {...own, runId: 'other-run'}]) {
      await expect(t.mutation(api.turns.commit, commitArgs(first, {end: {status: 'ready'}, messages: [message]})))
        .rejects.toThrow('only new assistant messages');
    }
    expect(await snapshot()).toEqual(before);
    await t.mutation(api.turns.commit, commitArgs(first, {end: {status: 'ready'}, messages: [own]}));
    const reused = commitArgs({...first, expectedTurnIndex: 1}, {end: {status: 'ready'}, messages: [own]});
    await expect(t.mutation(api.turns.commit, reused)).rejects.toThrow('only new assistant messages');
    expect((await snapshot()).run?.workflow?.nextTurnIndex).toBe(1);
  });

  it('keeps the first run taint and refuses tainted tool results without one (PRA-57)', async () => {
    const {t, first, snapshot} = await setup();
    const tainted = [assistantMessage(first, TAINTED_RESULT)];
    await expect(t.mutation(api.turns.commit, commitArgs(first, {end: {status: 'ready'}, messages: tainted})))
      .rejects.toThrow('need run taint');
    expect((await snapshot()).messages).toEqual([]);
    expect(await t.query(api.turns.state, {serverToken: SERVER_TOKEN, ...first})).toEqual({state: 'open', runTainted: false});
    await t.mutation(api.turns.commit, commitArgs(first, {end: {status: 'ready'}, messages: tainted, taint: TAINT}));
    const second = {...first, expectedTurnIndex: 1};
    expect(await t.query(api.turns.state, {serverToken: SERVER_TOKEN, ...second})).toEqual({state: 'open', runTainted: true});
    await t.mutation(api.turns.commit, commitArgs(second, {end: {status: 'ready'},
      taint: {tainted: true, source: 'Slack', callId: 'call-9'}}));
    expect((await snapshot()).run?.value.taint).toEqual(TAINT);
  });

  it('parks the run on the pending approval a suspended turn names (PRA-56)', async () => {
    const {t, first, userId, runId, snapshot} = await setup();
    await t.run(ctx => ctx.db.insert('approvals', {
      userId, id: 'approval-1', runId, toolCallId: 'call-1', tool: 'gmail.send', argsHash: 'a'.repeat(64),
      preview: 'Send the draft', status: 'pending', revision: 1, updatedAt: NOW,
    }));
    const suspend = (callId: string) => commitArgs(first, {end: {status: 'suspended', callId, approvalId: 'approval-1'}});
    await expect(t.mutation(api.turns.commit, suspend('call-2'))).rejects.toThrow('pending approval');
    expect(await t.mutation(api.turns.commit, suspend('call-1'))).toMatchObject({flags: {done: false, status: 'ready'}});
    const after = await snapshot();
    expect(after.run?.value.status).toBe('paused');
    expect(after.turns).toMatchObject([{suspension: {callId: 'call-1', approvalId: 'approval-1'}}]);
    const next = {...first, expectedTurnIndex: 1};
    expect(await t.query(internal.turns.preflight, next)).toEqual({state: 'settled',
      flags: {done: false, status: 'busy', subagents: [], turnIndex: 1}});
  });

  it('serves the worker pre-check only to the server token holder', async () => {
    const {t, first} = await setup();
    await expect(t.query(api.turns.state, {serverToken: 'x'.repeat(40), ...first})).rejects.toThrow('Server authentication');
    await expect(t.mutation(api.turns.commit, {...commitArgs(first), serverToken: 'x'.repeat(40)}))
      .rejects.toThrow('Server authentication');
  });
});
