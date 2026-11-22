import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type WorkflowId} from '@convex-dev/workflow';
import {getConvexSize, type Value} from 'convex/values';
import {api, internal} from '../convex/_generated/api.js';
import {GENERATION_TURNS_MAX} from '../convex/workflows/constants.js';
import {workflow} from '../convex/workflows/agentRun.js';
import {SERVER_TOKEN, startedRun, type WorkflowTest} from './workflow-fixture.js';
import {defaultEnd, fakeOpenRouter} from './workflow-model.js';

const SCRIPTED_TURNS = 100;
const JOURNAL_PAGE_MAX = 1_000;
// convex-test replays every journal step in-process, so a 100-turn run needs more than the 5 s default.
const LONG_RUN_TIMEOUT_MS = 60_000;
// A full 40-turn generation measured 34,568 bytes (PRA-31); content leaking into steps would blow past this.
const GENERATION_JOURNAL_BYTES_MAX = 64 * 1024;

const scriptedEnd = (turnIndex: number) => defaultEnd(turnIndex, SCRIPTED_TURNS);

async function currentWorkflowId(t: WorkflowTest, runId: Awaited<ReturnType<typeof startedRun>>['runId']) {
  const run = await t.run(ctx => ctx.db.get(runId));
  if (!run?.workflow?.id) throw new Error('Run has no workflow');
  return run.workflow.id as WorkflowId;
}

async function journalBytes(t: WorkflowTest, workflowId: WorkflowId): Promise<number> {
  const steps = await t.run(ctx => workflow.listSteps(ctx, workflowId, {paginationOpts: {numItems: JOURNAL_PAGE_MAX, cursor: null}}));
  return steps.page.reduce((total, step) => total + getConvexSize(JSON.parse(JSON.stringify(step)) as Value), 0);
}

/** Runs `after` once the model has answered the given turn, before the turn commits. */
function afterTurn(worker: Awaited<ReturnType<typeof fakeOpenRouter>>, after: (turnIndex: number) => Promise<void>) {
  const forward = worker.fetch.getMockImplementation();
  if (!forward) throw new Error('Fake OpenRouter has no fetch implementation');
  worker.fetch.mockImplementation(async (input, init) => {
    const response = await forward(input, init);
    await after(worker.modelCalls.at(-1)!.expectedTurnIndex);
    return response;
  });
}

describe('continue-as-new hand-off', () => {
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

  it('runs 100 turns across three generations with contiguous sequence and one terminal status', async () => {
    const {t, runId, scope} = await startedRun();
    const worker = await fakeOpenRouter(t, scope, scriptedEnd);
    const generations: WorkflowId[] = [];
    const journals: number[] = [];
    afterTurn(worker, async turnIndex => {
      if (turnIndex % GENERATION_TURNS_MAX === 0) generations.push(await currentWorkflowId(t, runId));
      const lastOfGeneration = (turnIndex + 1) % GENERATION_TURNS_MAX === 0 || turnIndex + 1 === SCRIPTED_TURNS;
      if (lastOfGeneration) journals.push(await journalBytes(t, await currentWorkflowId(t, runId)));
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers(), SCRIPTED_TURNS * 20);

    const run = await t.run(ctx => ctx.db.get(runId));
    expect(run).toMatchObject({value: {status: 'completed'}, workflow: {generation: 2, nextTurnIndex: SCRIPTED_TURNS}});
    expect(worker.modelCalls.map(call => call.expectedTurnIndex)).toEqual(Array.from({length: SCRIPTED_TURNS}, (_, i) => i));
    expect(worker.modelCalls.map(call => call.generation)).toEqual(
      Array.from({length: SCRIPTED_TURNS}, (_, i) => Math.floor(i / GENERATION_TURNS_MAX)),
    );
    const messages = await t.run(ctx => ctx.db.query('messages').collect());
    // The prompt, two messages per tool turn, and the final answer.
    expect(messages.map(message => message.sequence)).toEqual(Array.from({length: 2 * SCRIPTED_TURNS}, (_, i) => i + 1));
    const turns = await t.run(ctx => ctx.db.query('turns').collect());
    expect(turns.filter(turn => turn.done)).toHaveLength(1);
    expect([0, 1, 2].map(generation => turns.filter(turn => turn.generation === generation).length)).toEqual([40, 40, 20]);

    expect(new Set(generations).size).toBe(3);
    expect(generations.at(-1)).toBe(run?.workflow?.id);
    const [first, second, last] = await t.run(ctx => Promise.all(generations.map(id => workflow.status(ctx, id).catch(() => null))));
    expect([first, second]).toEqual([null, null]);
    expect(last).toMatchObject({type: 'completed'});
    expect(journals).toHaveLength(3);
    expect(Math.max(...journals)).toBeLessThan(GENERATION_JOURNAL_BYTES_MAX);
  }, LONG_RUN_TIMEOUT_MS);

  it('stops generation 2 when Stop arrives after a hand-off', async () => {
    const {t, owner, runId, scope} = await startedRun();
    const worker = await fakeOpenRouter(t, scope, scriptedEnd);
    const stopAt = GENERATION_TURNS_MAX + 5;
    afterTurn(worker, async turnIndex => {
      if (turnIndex === stopAt) await owner.mutation(api.runs.cancel, {runId});
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers(), SCRIPTED_TURNS * 20);

    const run = await t.run(ctx => ctx.db.get(runId));
    // Stop lands after the model answered but before the commit, so the cancel fence keeps that turn out.
    expect(run).toMatchObject({value: {status: 'cancelled'}, workflow: {generation: 1, nextTurnIndex: stopAt}});
    expect(worker.modelCalls.at(-1)).toMatchObject({generation: 1, expectedTurnIndex: stopAt});
    const status = await t.run(ctx => workflow.status(ctx, run!.workflow!.id as WorkflowId));
    expect(status).toEqual({type: 'completed', result: 'cancelled'});
  }, LONG_RUN_TIMEOUT_MS);

  it('fences the old generation once the successor owns the run', async () => {
    const {t, runId, scope} = await startedRun();
    await fakeOpenRouter(t, scope);
    const oldScope = {...scope, generation: 0};
    expect(await t.mutation(internal.runs.continueAsNew, {...oldScope, turnIndex: 0})).toEqual({continued: true});
    expect(await t.mutation(internal.runs.continueAsNew, {...oldScope, turnIndex: 0})).toEqual({continued: false});
    await expect(t.mutation(internal.runs.continueAsNew, {...oldScope, generation: 1, turnIndex: 3}))
      .rejects.toThrow('Unexpected turn index');
    await expect(t.action(internal.turns.run, {...oldScope, expectedTurnIndex: 0})).rejects.toThrow('unavailable');
    expect(await t.mutation(internal.runs.transition, {...oldScope, from: 'running', to: 'failed', turnIndex: 0}))
      .toEqual({applied: false});
    expect((await t.run(ctx => ctx.db.get(runId)))?.workflow).toMatchObject({generation: 1, nextTurnIndex: 0});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  });
});
