import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {convexTest} from 'convex-test';
import {api} from '../convex/_generated/api.js';
import schema from '../convex/schema.js';
import {SERVER_TOKEN} from './workflow-fixture.js';

const server = api.composio.server;
const LINK_LIFETIME_MS = 60_000;

async function setup() {
  const t = convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/composio/server.ts': () => import('../convex/composio/server.js'),
  });
  const userId = await t.run(ctx => ctx.db.insert('users', {}));
  const now = Date.now();
  await t.run(async ctx => {
    for (const [toolkit, status] of [['gmail', 'connected'], ['slack', 'pending'], ['github', 'failed']] as const) {
      await ctx.db.insert('connections', {userId, toolkit, status, connectedAccountId: `ca_${toolkit}`,
        redirectUrl: `https://connect.test/${toolkit}`, expiresAt: now + LINK_LIFETIME_MS, createdAt: now, updatedAt: now});
    }
  });
  return {t, userId};
}
const usage = (userId: string, callId: string, executions: number) =>
  ({serverToken: SERVER_TOKEN, request: {userId, runId: 'run', callId, period: '2026-11', executions}});

describe('Composio server RPC', () => {
  beforeEach(() => vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN));
  afterEach(() => vi.unstubAllEnvs());

  it('lists only connected accounts and requires the server token', async () => {
    const {t, userId} = await setup();
    expect(await t.query(server.connectedAccounts, {serverToken: SERVER_TOKEN, request: {userId}}))
      .toEqual([{toolkit: 'gmail', connectedAccountId: 'ca_gmail'}]);
    await expect(t.query(server.connectedAccounts, {serverToken: 'x'.repeat(40), request: {userId}}))
      .rejects.toThrow('Server authentication required');
  });

  it('counts executions once per run and call', async () => {
    const {t, userId} = await setup();
    await t.mutation(server.recordUsage, usage(userId, 'call-1', 3));
    await t.mutation(server.recordUsage, usage(userId, 'call-1', 3));
    await t.mutation(server.recordUsage, usage(userId, 'call-2', 2));
    const row = await t.run(ctx => ctx.db.query('toolState')
      .withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', 'composioUsage').eq('id', '2026-11')).unique());
    expect(row?.value).toEqual({encoded: JSON.stringify({executions: 5})});
  });

  it('refuses to count for an unknown owner', async () => {
    const {t} = await setup();
    await expect(t.mutation(server.recordUsage, usage('missing-user', 'call', 1))).rejects.toThrow('Account unavailable');
  });
});
