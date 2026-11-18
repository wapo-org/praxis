import { blobOwnerTag } from '../convex/blobOwner.js';
import { accountEraser } from '../apps/api/src/account-deletion.js';
import { createApp } from '../apps/api/src/app.js';
import { ApiService } from '../apps/api/src/service.js';
import { it, expect, afterEach, vi } from 'vitest';
import { registerCore } from '@convex-dev/auth/test';
import { registerEmail } from '@convex-dev/auth/components/email/test';
import { registerPassword } from '@convex-dev/auth/components/password/test';
import { registerGoogleOauth } from '@convex-dev/auth/components/google/test';
import { registerAppleOauth } from '@convex-dev/auth/components/apple/test';
import { signedInUser } from './workflow-fixture.js';
import { api } from '../convex/_generated/api.js';
import { ACCOUNT_DELETE_PATH } from '@praxis/protocol';
import { convexHarness } from '../apps/api/src/adapters/testing/convex-harness.js';
import { fakeRedis } from '../apps/api/src/adapters/testing/fake-redis.js';
import type { Redis } from '@upstash/redis';
import { upstashFromRedis, createRateLimiter } from '../apps/api/src/adapters/upstash.js';
import { storeFromRPC } from '../apps/api/src/adapters/convex.js';
import { createPraxisApp } from '../apps/api/src/server.js';
import { createLocalAdapters } from '../apps/api/src/local-memory.js';
const API = 'http://127.0.0.1:8822';
const ownerTables = ['records', 'changes', 'sequences', 'toolState', 'toolSkillFiles', 'files'] as const;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('deletes every owned table, blob, Redis key and session; preserves another user; rejects stale writes and replay', async () => {
  const { t, rpc } = convexHarness();
  const memory = fakeRedis(),
    redis = upstashFromRedis(memory.redis, { accountOwnership: true });
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  vi.stubEnv('SITE_URL', 'https://app.example.test');
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  vi.stubEnv('SENDER_EMAIL', 'auth@example.test');
  vi.stubEnv('SENDER_NAME', 'Praxis');
  vi.useFakeTimers();
  for (const register of [registerCore, registerEmail, registerPassword, registerGoogleOauth, registerAppleOauth]) {
    register(t);
  }
  const a = await signedInUser(t);
  const b = await signedInUser(t);
  const alias = await signedInUser(t, a.userId);
  const clients = new Map([a, b, alias].map(user => [user.accessToken, user.client]));
  function clientFor(request: Request) {
    return clients.get(request.headers.get('authorization')?.slice('Bearer '.length) ?? '');
  }
  const app = createPraxisApp({
    local: false,
    adapters: { store: storeFromRPC(rpc), kv: redis.kv, events: redis.events },
    async resolveSession(request) {
      const client = clientFor(request);
      if (!client) return null;
      const deleting = request.method === 'DELETE' && new URL(request.url).pathname === ACCOUNT_DELETE_PATH;
      const userId = deleting
        ? (await client.query(api.account.deletionOwner, {}))?.userId
        : await client.query(api.auth.currentUser, {});
      if (!userId) return null;
      if (!deleting) {
        await redis.ownership.activate(userId, async () => await rpc.query('account:active', { userId }) === true);
      }
      return { user: { type: 'user', id: userId, name: 'Test user' }, expiresAt: new Date().toISOString() };
    },
    accountDeletion: {
      async confirm(request, password) {
        return await clientFor(request)?.mutation(api.account.confirmDeletion, { password }) ?? null;
      },
      purge: accountEraser(rpc, redis.ownership),
    },
  }).app;
  const call = (path: string, method = 'GET', token?: string, body?: unknown) =>
    app.request(API + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await call('/v1/bootstrap', 'GET', alias.accessToken)).status).toBe(200);
  expect((await call('/v1/bootstrap', 'GET', b.accessToken)).status).toBe(200);
  for (const u of [a.userId, b.userId]) {
    for (const kind of [
      'chat',
      'message',
      'run',
      'connector',
      'skill',
      'checkpoint',
      'modelPreference',
      'modelKey',
      'consent',
    ])
      await rpc.mutation('store:put', { userId: u, kind, id: kind, value: { private: u } });
    await rpc.mutation('tools:put', {
      userId: u,
      kind: 'skill',
      id: 's',
      value: { files: { 'SKILL.md': 'instructions' } },
    });
    await rpc.mutation('tools:put', {
      userId: u,
      kind: 'javascriptKV',
      id: 'chat',
      value: { key: 'private' },
    });
    const limit = createRateLimiter(memory.redis as Redis, { requests: 2 });
    await limit(`user:${u}`);
    await redis.kv.set('cache:' + u, { private: u }, 600, u);
    await redis.kv.set('oauth:' + u, { userId: u }, 600, u);
    await redis.events.append(u, 'run:r', { private: u }, 'stable');
    await redis.lease.acquire('run:' + u + ':r', 10000, u);
    await t.run(async (ctx) => {
      const blob = await ctx.storage.store(
        new Blob([u], { type: `text/plain;${await blobOwnerTag(u)}` }),
      );
      await ctx.storage.store(
        new Blob(['orphan'], { type: `text/plain;${await blobOwnerTag(u)}` }),
      );
      await ctx.db.insert('files', {
        userId: u,
        ticket: u,
        name: 'upload',
        mediaType: 'text/plain',
        size: u.length,
        expiresAt: Date.now() + 9999,
        status: 'ready',
        storageId: blob,
      });
      await ctx.db.insert('files', {
        userId: u,
        ticket: 'pending-' + u,
        name: 'pending',
        mediaType: 'text/plain',
        size: 1,
        expiresAt: Date.now() + 9999,
        status: 'pending',
      });
    });
  }
  const beforeOther = await t.run(ctx => Promise.all(ownerTables.map(async table =>
    (await ctx.db.query(table).collect()).filter(row => row.userId === b.userId),
  )));
  const ownKeys = memory.index(redis.ownership.keys(a.userId).index);
  expect(ownKeys.length).toBeGreaterThan(5);
  const original = rpc.mutation;
  let failOnce = true;
  rpc.mutation = async (name, args) => {
    if (name === 'account:purge' && failOnce) {
      failOnce = false;
      throw Error('transient deletion failure');
    }
    return original(name, args);
  };
  expect(
    (await call('/v1/account', 'DELETE', a.accessToken, { type: 'account.delete' })).status,
  ).toBe(503);
  expect((await call('/v1/bootstrap', 'GET', alias.accessToken)).status).toBe(401);
  expect((await call('/v1/account', 'DELETE', a.accessToken)).status).toBe(200);

  await t.run(async (ctx) => {
    for (const [index, table] of ownerTables.entries()) {
      const rows = await ctx.db.query(table).collect();
      expect(rows.filter(row => row.userId === a.userId)).toEqual([]);
      expect(rows.filter(row => row.userId === b.userId)).toEqual(beforeOther[index]);
    }
    expect(await ctx.db.get(a.userId)).toBeNull();
    expect((await ctx.db.system.query('_storage').collect()).length).toBe(2);
  });
  for (const key of [...ownKeys, ...Object.values(redis.ownership.keys(a.userId))])
    expect(memory.keys()).not.toContain(key);
  expect((await call('/v1/bootstrap', 'GET', alias.accessToken)).status).toBe(401);
  expect((await call('/v1/account', 'DELETE', a.accessToken, {})).status).toBe(401);
  expect(await rpc.mutation('account:purge', { userId: a.userId })).toEqual({ done: true });
  await expect(
    rpc.mutation('store:put', {
      userId: a.userId,
      requireOwner: true,
      kind: 'chat',
      id: 'late',
      value: {},
    }),
  ).rejects.toThrow();
  await expect(
    redis.ownership.activate(
      a.userId,
      async () => !!(await rpc.query('account:active', { userId: a.userId })),
    ),
  ).rejects.toThrow();
  await expect(redis.events.append(a.userId, 'run:r', {})).rejects.toThrow();
  await expect(redis.kv.set('late', {}, 600, a.userId)).rejects.toThrow();
  expect((await call('/v1/bootstrap', 'GET', b.accessToken)).status).toBe(200);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
});
it('limits local deletion attempts', async () => {
  const local = createApp({ service: new ApiService(createLocalAdapters(), true) }).app;
  const dev = await (
    await local.request(API + '/v1/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"auth.dev","userId":"limited"}',
    })
  ).json();
  const req = () =>
    local.request(API + '/v1/account', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${dev.bearerToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  for (let i = 0; i < 5; i++) expect((await req()).status).toBe(503);
  expect((await req()).status).toBe(429);
});
