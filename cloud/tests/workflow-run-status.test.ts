import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FunctionReference} from 'convex/server';
import {RunStatusSchema} from '@praxis/protocol';
import {api, internal} from '../convex/_generated/api.js';
import type {Id} from '../convex/_generated/dataModel.js';
import {chatId, startedRun, workflowTest, signedInUser} from './workflow-fixture.js';

// PRA-25 contract: the transition table from the issue, kept independent of the production table it checks.
const STATUSES = ['queued', 'running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled'] as const;
type Status = typeof STATUSES[number];
const TERMINAL: readonly Status[] = ['completed', 'failed', 'cancelled'];
const LEGAL = new Set<string>([
  'queued>running',
  'running>paused', 'paused>running',
  'running>cancelling', 'paused>cancelling', 'cancelling>cancelled',
  'running>completed',
  ...STATUSES.filter(from => !TERMINAL.includes(from)).map(from => `${from}>failed`),
]);
const PAIRS = STATUSES.flatMap(from => STATUSES.map(to => ({from, to, legal: LEGAL.has(`${from}>${to}`)})));

type TransitionArgs = {
  userId: string; chatId: string; runId: Id<'runs'>; generation: number; from: Status; to: Status; turnIndex: number;
};
type TransitionRef = FunctionReference<'mutation', 'internal', TransitionArgs, {applied: boolean}>;
type StartArgs = {chatId: string; startTurnIndex?: number; idempotencyKey?: string};
type StartRef = FunctionReference<'mutation', 'public', StartArgs, Id<'runs'>>;

const transitionRef = internal.runs.transition as unknown as TransitionRef;
const start = api.runs.start as unknown as StartRef;

type Started = Awaited<ReturnType<typeof startedRun>>;

async function seedStatus(run: Started, status: Status) {
  await run.t.run(async ctx => {
    const row = await ctx.db.get(run.runId);
    if (!row?.workflow) throw new Error('Seeded run is missing workflow state');
    await ctx.db.patch(run.runId, {
      value: {...row.value, status} as typeof row.value,
    });
  });
}

async function storedStatus(run: Started) {
  const row = await run.t.run(ctx => ctx.db.get(run.runId));
  if (!row?.workflow) throw new Error('Run row disappeared');
  return {status: row.value.status, turnIndex: row.workflow.nextTurnIndex};
}

async function transition(run: Started, from: Status, to: Status, turnOffset = 0) {
  const {turnIndex} = await storedStatus(run);
  return run.t.mutation(transitionRef, {...run.scope, from, to, turnIndex: turnIndex + turnOffset});
}

async function runRows(run: Pick<Started, 't'>) {
  return run.t.run(ctx => ctx.db.query('runs').collect());
}

describe('PRA-25 run status state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps terminal statuses without outgoing transitions in the contract table', () => {
    expect(PAIRS.filter(({from, legal}) => legal && TERMINAL.includes(from))).toEqual([]);
  });

  it('treats Stop on a completed run as a no-op', async () => {
    const run = await startedRun();
    await seedStatus(run, 'completed');
    await run.owner.mutation(api.runs.cancel, {runId: run.runId});
    expect(await storedStatus(run)).toMatchObject({status: 'completed'});
  });

  describe('runs.transition compare-and-set', () => {
    it('exposes every contract status on the wire schema', () => {
      expect(RunStatusSchema.options).toEqual(expect.arrayContaining([...STATUSES]));
    });

    it.each(PAIRS)('$from → $to applies only when legal ($legal)', async ({from, to, legal}) => {
      const run = await startedRun();
      await seedStatus(run, from);
      await expect(transition(run, from, to)).resolves.toEqual({applied: legal});
      expect((await storedStatus(run)).status).toBe(legal ? to : from);
    });

    it.each(STATUSES.filter(status => status !== 'running'))(
      'returns applied:false without writing when from=%s mismatches running',
      async staleFrom => {
        const run = await startedRun();
        const target = STATUSES.find(to => LEGAL.has(`${staleFrom}>${to}`)) ?? 'failed';
        await expect(transition(run, staleFrom, target)).resolves.toEqual({applied: false});
        expect((await storedStatus(run)).status).toBe('running');
      },
    );

    it('returns applied:false without writing when turnIndex is stale', async () => {
      const run = await startedRun();
      await expect(transition(run, 'running', 'paused', 1)).resolves.toEqual({applied: false});
      expect((await storedStatus(run)).status).toBe('running');
    });

    it('applies exactly one of two racing transitions out of running', async () => {
      const run = await startedRun();
      const results = await Promise.all([
        transition(run, 'running', 'paused'),
        transition(run, 'running', 'cancelling'),
      ]);
      expect(results.filter(result => result.applied)).toHaveLength(1);
      expect(['paused', 'cancelling']).toContain((await storedStatus(run)).status);
    });

    it('lets Stop move a paused run to cancelling', async () => {
      const run = await startedRun();
      await seedStatus(run, 'paused');
      await run.owner.mutation(api.runs.cancel, {runId: run.runId});
      expect((await storedStatus(run)).status).toBe('cancelling');
    });
  });

  describe('idempotent start and one active run per chat', () => {
    async function ownedChat() {
      const t = workflowTest();
      const {userId, client: owner} = await signedInUser(t);
      await owner.mutation(api.chats.create, {input: {type: 'chat.input', id: chatId}});
      return {t, userId, owner};
    }

    it('returns the same run id for a repeated start with the same key', async () => {
      const {t, owner} = await ownedChat();
      const first = await owner.mutation(start, {chatId, idempotencyKey: 'turn-1'});
      const second = await owner.mutation(start, {chatId, idempotencyKey: 'turn-1'});
      expect(second).toBe(first);
      expect(await runRows({t})).toHaveLength(1);
    });

    it('returns the same run id when two tabs start with the same key at once', async () => {
      const {t, owner} = await ownedChat();
      const [first, second] = await Promise.all([
        owner.mutation(start, {chatId, idempotencyKey: 'turn-1'}),
        owner.mutation(start, {chatId, idempotencyKey: 'turn-1'}),
      ]);
      expect(second).toBe(first);
      expect(await runRows({t})).toHaveLength(1);
    });

    it('gives the losing tab the existing active run when starts race without a key', async () => {
      const {t, owner} = await ownedChat();
      const [first, second] = await Promise.all([
        owner.mutation(start, {chatId}),
        owner.mutation(start, {chatId}),
      ]);
      expect(second).toBe(first);
      const rows = await runRows({t});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workflow?.id).toBeDefined();
    });

    it('rejects a reused key with a different body', async () => {
      const {owner} = await ownedChat();
      await owner.mutation(start, {chatId, idempotencyKey: 'turn-1'});
      await expect(owner.mutation(start, {chatId, idempotencyKey: 'turn-1', startTurnIndex: 1}))
        .rejects.toThrow('idempotency_conflict');
    });

    it('replays a key after the run ends and starts a new run for a new key', async () => {
      const {t, owner} = await ownedChat();
      const first = await owner.mutation(start, {chatId, idempotencyKey: 'turn-1'});
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(await owner.mutation(start, {chatId, idempotencyKey: 'turn-1'})).toBe(first);
      const next = await owner.mutation(start, {chatId, idempotencyKey: 'turn-2'});
      expect(next).not.toBe(first);
      expect(await runRows({t})).toHaveLength(2);
    });
  });
});
