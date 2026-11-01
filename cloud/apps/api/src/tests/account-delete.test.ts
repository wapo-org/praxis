import { blobOwnerTag } from '../../../../convex/blob-owner.js';
import { accountEraser } from '../account-deletion.js';
import { createApp } from '../app.js';
import { ApiService } from '../service.js';
import { it, expect, vi } from 'vitest';
import { convexHarness } from '../adapters/testing/convex-harness.js';
import { fakeRedis } from '../adapters/testing/fake-redis.js';
import type { Redis } from '@upstash/redis';
import { upstashFromRedis, createRateLimiter } from '../adapters/upstash.js';
import { authFromRPC } from '../adapters/auth.js';
import { storeFromRPC } from '../adapters/convex.js';
import { createPraxisApp } from '../server.js';
import { createLocalAdapters } from '../local-memory.js';
const API = 'http://127.0.0.1:8822';
it('deletes every owned table, blob, Redis key and session; preserves another user; rejects stale writes and replay', async () => {
  const { t, rpc } = convexHarness();
  const memory = fakeRedis(),
    redis = upstashFromRedis(memory.redis, { accountOwnership: true });
  const auth = authFromRPC(rpc, {
    baseURL: API,
    secret: 'test-only-secret-at-least-thirty-two-characters',
    trustedOrigins: [],
    cache: redis.kv,
    ownership: {
      isActive: redis.ownership.isActive,
      activate: (userId) =>
        redis.ownership.activate(
          userId,
          async () => !!(await rpc.query('account:active', { userId })),
        ),
    },
  });
  const app = createPraxisApp({
    local: false,
    adapters: { store: storeFromRPC(rpc), kv: redis.kv, events: redis.events },
    resolveSession: auth.resolveSession,
    authHandler: auth.handler,
    accountDeletion: { confirm: auth.confirmDeletion, purge: accountEraser(rpc, redis.ownership) },
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
  const signup = async (email: string) => {
    const r = await call('/v1/auth/sign-up', 'POST', undefined, {
      type: 'auth.input',
      email,
      password: 'test-password-at-least-twelve',
      name: 'Delete test',
    });
    expect(r.status).toBe(201);
    return r.json();
  };
  const a = await signup('delete-a@example.test'),
    b = await signup('delete-b@example.test');
  const alias = await (
    await call('/v1/auth/sign-in', 'POST', undefined, {
      type: 'auth.input',
      email: 'delete-a@example.test',
      password: 'test-password-at-least-twelve',
    })
  ).json();
  for (const u of [a.user.id, b.user.id]) {
    for (const kind of [
      'chat',
      'message',
      'run',
      'connector',
      'skill',
      'checkpoint',
      'modelLearning',
      'providerSecret',
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
    const limit = createRateLimiter(memory.redis as Redis, {
      requests: 2,
      ownership: redis.ownership,
    });
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
      await ctx.db.insert('authDocuments', {
        model: 'rateLimit',
        id: 'rate-' + u,
        data: { userId: u, count: 1 },
      });
      await ctx.db.insert('authDocuments', {
        model: 'verification',
        id: 'verify-' + u,
        data: { identifier: `reset-password:${u}`, value: u },
      });
    });
  }
  await call('/v1/bootstrap', 'GET', alias.bearerToken); // both credential aliases hot-cached
  const beforeOther = await t.run(async (ctx) => {
    const rows = {};
    for (const table of [
      'records',
      'changes',
      'sequences',
      'toolState',
      'toolSkillFiles',
      'files',
      'authDocuments',
    ] as const)
      (rows as any)[table] = (await ctx.db.query(table).collect()).filter(
        (r: any) =>
          r.userId === b.user.id ||
          r.data?.userId === b.user.id ||
          r.id === b.user.id ||
          r.data?.value === b.user.id,
      );
    return rows;
  });
  const ownKeys = await (memory.redis as any).smembers(redis.ownership.keys(a.user.id).index);
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
    (await call('/v1/account', 'DELETE', a.bearerToken, { type: 'account.delete' })).status,
  ).toBe(500);
  expect((await call('/v1/bootstrap', 'GET', alias.bearerToken)).status).toBe(401);
  expect((await call('/v1/account', 'DELETE', a.bearerToken)).status).toBe(200);

  await t.run(async (ctx) => {
    for (const table of [
      'records',
      'changes',
      'sequences',
      'toolState',
      'toolSkillFiles',
      'files',
      'authDocuments',
    ] as const) {
      const rows = await ctx.db.query(table).collect();
      expect(
        rows.filter(
          (r: any) =>
            r.userId === a.user.id ||
            r.data?.userId === a.user.id ||
            r.id === a.user.id ||
            r.data?.value === a.user.id,
        ),
      ).toEqual([]);
      expect(
        rows.filter(
          (r: any) =>
            r.userId === b.user.id ||
            r.data?.userId === b.user.id ||
            r.id === b.user.id ||
            r.data?.value === b.user.id,
        ),
      ).toEqual((beforeOther as any)[table]);
    }
    expect((await ctx.db.system.query('_storage').collect()).length).toBe(2);
  });
  for (const key of [...ownKeys, ...Object.values(redis.ownership.keys(a.user.id))])
    expect(memory.keys()).not.toContain(key);
  expect((await call('/v1/bootstrap', 'GET', alias.bearerToken)).status).toBe(401);
  expect((await call('/v1/account', 'DELETE', a.bearerToken, {})).status).toBe(401);
  expect(await rpc.mutation('account:purge', { userId: a.user.id })).toEqual({ done: true });
  await expect(
    rpc.mutation('store:put', {
      userId: a.user.id,
      requireOwner: true,
      kind: 'chat',
      id: 'late',
      value: {},
    }),
  ).rejects.toThrow();
  await expect(
    redis.ownership.activate(
      a.user.id,
      async () => !!(await rpc.query('account:active', { userId: a.user.id })),
    ),
  ).rejects.toThrow();
  await expect(redis.events.append(a.user.id, 'run:r', {})).rejects.toThrow();
  await expect(redis.kv.set('late', {}, 600, a.user.id)).rejects.toThrow();
  expect((await call('/v1/bootstrap', 'GET', b.bearerToken)).status).toBe(200);
});
it('requires password for old sessions, accepts the current password, and limits deletion attempts', async () => {
  const { rpc } = convexHarness();
  const auth = authFromRPC(rpc, {
    baseURL: API,
    secret: 'test-only-secret-at-least-thirty-two-characters',
    trustedOrigins: [],
  });
  const credentials = {
    type: 'auth.input',
    email: 'old@example.test',
    password: 'correct-password-123',
    name: 'Old',
  };
  const sign = await auth.handler(
    new Request(API + '/v1/auth/sign-up', {
      method: 'POST',
      body: JSON.stringify(credentials),
      headers: { 'content-type': 'application/json' },
    }),
  );
  const session = await sign.json();
  const request = new Request(API + '/v1/account', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.bearerToken}` },
  });
  await rpc.mutation('auth:execute', {
    operation: 'updateMany',
    input: {
      model: 'session',
      where: [{ field: 'userId', value: session.user.id }],
      update: { createdAt: new Date(Date.now() - 300001).toISOString() },
    },
  });
  expect(await auth.confirmDeletion(request)).toBeNull();
  expect(await auth.confirmDeletion(request, 'wrong')).toBeNull();
  expect(await auth.confirmDeletion(request, credentials.password)).toMatchObject({
    userId: session.user.id,
  });
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
