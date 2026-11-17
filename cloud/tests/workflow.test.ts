import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {convexTest} from 'convex-test';
import workflowComponent from '@convex-dev/workflow/test';
import {type WorkflowId} from '@convex-dev/workflow';
import {TURN_RESULT_MAX_BYTES, TurnResultSchema} from '@praxis/protocol';
import schema from '../convex/schema.js';
import {api, internal} from '../convex/_generated/api.js';
import {workflow} from '../convex/workflows/agentRun.js';

const userId = 'workflow-user';
const chatId = 'workflow-chat';
async function setup() {
  const t = convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/account.ts': () => import('../convex/account.js'),
    '../convex/runs.ts': () => import('../convex/runs.js'),
    '../convex/turns.ts': () => import('../convex/turns.js'),
    '../convex/workflows/agentRun.ts': () => import('../convex/workflows/agentRun.js'),
  });
  workflowComponent.register(t);
  await t.run(ctx => ctx.db.insert('authDocuments', {model: 'user', id: userId, data: {id: userId}}));
  await t.run(ctx => ctx.db.insert('records', {
    userId, kind: 'chat', id: chatId, value: {}, revision: 1, updatedAt: new Date().toISOString(), deleted: false,
  }));
  const owner = t.withIdentity({subject: userId});
  const runId = await owner.mutation(api.runs.start, {chatId});
  const scope = {userId, chatId, runId, generation: 0};
  return {t, owner, runId, scope};
}

describe('durable workflow skeleton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('runs exactly three actions, completes, and journals only bounded flags', async () => {
    const {t, runId} = await setup();
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const run = await t.run(ctx => ctx.db.get(runId));
    expect(run).toMatchObject({status: 'completed', nextTurnIndex: 3});
    const steps = await t.run(ctx => workflow.listSteps(ctx, run!.workflowId as WorkflowId));
    const turns = steps.page.filter(step => step.name === 'turns:run');
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(turn.runResult?.kind).toBe('success');
      if (turn.runResult?.kind !== 'success') throw new Error('Missing flags');
      expect(Object.keys(TurnResultSchema.parse(turn.runResult.returnValue)).sort()).toEqual(['done', 'status', 'subagents', 'turnIndex']);
      expect(JSON.stringify(turn.runResult.returnValue).length).toBeLessThan(TURN_RESULT_MAX_BYTES);
    }
  });
  it('preserves a terminal worker failure instead of completing the run', async () => {
    const parse = TurnResultSchema.parse.bind(TurnResultSchema);
    vi.spyOn(TurnResultSchema, 'parse').mockImplementation(input => {
      const flags = parse(input);
      return flags.done ? {...flags, status: 'failed', failure: {
        code: 'model_key_invalid', message: 'Provider unavailable', remediation: 'Reconnect provider',
      }} : flags;
    });
    const {t, runId} = await setup();
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await t.run(ctx => ctx.db.get(runId)))?.status).toBe('failed');
  });
  it('redelivers committed turns concurrently without advancing twice', async () => {
    const {t, scope, runId} = await setup();
    const args = {...scope, expectedTurnIndex: 0};
    const results = await Promise.all([t.action(internal.turns.run, args), t.action(internal.turns.run, args)]);
    expect(results[0]).toEqual(results[1]);
    expect((await t.run(ctx => ctx.db.get(runId)))?.nextTurnIndex).toBe(1);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.action(internal.turns.run, args)).toEqual(results[0]);
    expect(await t.run(ctx => ctx.db.query('turnFlags').collect())).toHaveLength(3);
  });
  it('cancels after a committed turn and fences a late action', async () => {
    const {t, owner, scope, runId} = await setup();
    await t.action(internal.turns.run, {...scope, expectedTurnIndex: 0});
    await owner.mutation(api.runs.cancel, {runId});
    expect(await t.action(internal.turns.run, {...scope, expectedTurnIndex: 1})).toMatchObject({done: true, status: 'stopped'});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({status: 'cancelled', nextTurnIndex: 1});
  });
  it('finalizes invalid flags as failed rather than looping', async () => {
    const {t, runId} = await setup();
    await t.run(ctx => ctx.db.insert('turnFlags', {runId, generation: 0, turnIndex: 0, done: false, status: 'completed'}));
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({status: 'failed', nextTurnIndex: 0});
  });
  it('rejects foreign users, missing auth, invalid indices and stale generations', async () => {
    const {t, owner, scope, runId} = await setup();
    await expect(t.mutation(api.runs.start, {chatId})).rejects.toThrow('Authentication required');
    await expect(t.withIdentity({subject: 'other'}).mutation(api.runs.start, {chatId})).rejects.toThrow('unavailable');
    await expect(t.withIdentity({subject: 'other'}).mutation(api.runs.cancel, {runId})).rejects.toThrow('unavailable');
    await expect(owner.mutation(api.runs.start, {chatId, startTurnIndex: -1})).rejects.toThrow();
    await expect(t.action(internal.turns.run, {...scope, expectedTurnIndex: 2})).rejects.toThrow('Unexpected turn');
    await expect(t.action(internal.turns.run, {...scope, expectedTurnIndex: 0, generation: 1})).rejects.toThrow('unavailable');
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  });
  it('does not overwrite a successor when an old completion arrives', async () => {
    const {t, runId, scope} = await setup();
    const run = await t.run(ctx => ctx.db.get(runId));
    await t.run(ctx => ctx.db.patch(runId, {generation: 1}));
    await t.mutation(internal.runs.onComplete, {workflowId: run!.workflowId as WorkflowId,
      context: scope, result: {kind: 'failed', error: 'old failure'}});
    expect((await t.run(ctx => ctx.db.get(runId)))?.status).toBe('running');
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  });
});
