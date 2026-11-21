import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import schema from '../convex/schema.js';
import {api, components, internal} from '../convex/_generated/api.js';
import {workflow} from '../convex/workflows/agentRun.js';
import {ACCOUNT_OWNER_ROWS, ACCOUNT_PURGE_POLICY, ACCOUNT_RUN_CHILD_ROWS} from '../convex/accountTables.js';
import {chatId, SERVER_TOKEN, startedRun} from './workflow-fixture.js';
import {commitArgs} from './workflow-commit.js';
import {fakeOpenRouter} from './workflow-model.js';

const PURGE_CALLS_MAX = 20;
type PurgeResult = {done: boolean; blobCursor?: string; blobsDone?: boolean};

describe('account deletion of workflow state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('gives every schema table an explicit purge policy with a row query', () => {
    expect(Object.keys(ACCOUNT_PURGE_POLICY).sort()).toEqual(Object.keys(schema.tables).sort());
    const tablesWith = (policy: string) => Object.entries(ACCOUNT_PURGE_POLICY)
      .filter(([, value]) => value === policy).map(([table]) => table).sort();
    expect(Object.keys(ACCOUNT_OWNER_ROWS).sort()).toEqual(tablesWith('ownerRows'));
    expect(Object.keys(ACCOUNT_RUN_CHILD_ROWS).sort()).toEqual(tablesWith('runChild'));
  });

  it('fences an in-flight run once deletion begins, then purges run, flags, journal and user', async () => {
    const {t, owner, userId, scope} = await startedRun();
    await fakeOpenRouter(t, scope);
    await t.action(internal.turns.run, {...scope, expectedTurnIndex: 0});
    const sessions = () => t.run(ctx => ctx.runQuery(components.auth.public.listSessions, {userId}));
    expect(await sessions()).toHaveLength(1);
    await t.mutation(api.account.begin, {serverToken: SERVER_TOKEN, userId});
    expect(await sessions()).toHaveLength(0);

    await expect(t.mutation(api.turns.commit, commitArgs({...scope, expectedTurnIndex: 1}))).rejects.toThrow('Account unavailable');
    await expect(owner.mutation(api.runs.start, {chatId})).rejects.toThrow();
    expect(await t.query(api.account.active, {serverToken: SERVER_TOKEN, userId})).toBe(false);

    let result: PurgeResult = {done: false};
    for (let call = 0; !result.done && call < PURGE_CALLS_MAX; call++) {
      result = await t.mutation(api.account.purge, {
        serverToken: SERVER_TOKEN, userId, blobCursor: result.blobCursor, blobsDone: result.blobsDone,
      });
    }
    expect(result.done).toBe(true);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const rows = await t.run(async ctx => ({
      users: await ctx.db.query('users').collect(),
      chats: await ctx.db.query('chats').collect(),
      runs: await ctx.db.query('runs').collect(),
      turns: await ctx.db.query('turns').collect(),
      workflows: (await workflow.list(ctx)).page,
    }));
    expect(rows).toEqual({users: [], chats: [], runs: [], turns: [], workflows: []});
    await expect(t.mutation(api.turns.commit, commitArgs({...scope, expectedTurnIndex: 1}))).rejects.toThrow('Account unavailable');
  });
});
