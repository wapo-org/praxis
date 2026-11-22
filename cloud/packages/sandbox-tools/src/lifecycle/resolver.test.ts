import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {makeFunctionReference} from 'convex/server';
import {MODAL_POOL} from '@praxis/credentials';
import {SANDBOX_FUNCTIONS, SANDBOX_LIFECYCLE, SANDBOX_RESOURCES} from '@praxis/protocol';
import {SANDBOX_MESSAGES, SANDBOX_VOLUME_MOUNT} from './constants.js';
import {CREDENTIALS, SERVER_TOKEN, failure, setup} from './fixture.js';
import {sandboxName} from './resolver.js';
import {convexSandboxRows} from './rows.js';

const COOLING_MS = 3_600_000;

let seen: unknown[] = [];
/** Every log line, result and error a test produced; none may carry a Modal credential. */
function remember<T>(value: T): T {
  seen.push(value);
  return value;
}

describe('sandbox lifecycle (PRA-52)', () => {
  beforeEach(() => {
    process.env.PRAXIS_CONVEX_SERVER_TOKEN = SERVER_TOKEN;
    seen = [];
  });
  afterEach(() => {
    const text = JSON.stringify(seen, (_key, value: unknown) => value instanceof Error ? {...value, message: value.message} : value);
    const leaked = Object.values(CREDENTIALS).filter(secret => text.includes(secret));
    if (leaked.length) throw new Error(`${leaked.length} Modal credential value(s) reached logs, results or errors`);
  });

  it('boots exactly one sandbox for five simultaneous calls on a cold user', async () => {
    const {resolver, modal, owner, row, logs} = setup();
    const userId = await owner();
    const results = await Promise.all(Array.from({length: 5}, () => resolver.ensure(userId, 'workspace')));
    remember({results: results.map(({sandboxId, booted}) => ({sandboxId, booted})), logs});
    expect(modal.creates).toBe(1);
    expect(new Set(results.map(r => r.sandboxId))).toEqual(new Set(['sb-1']));
    expect(results.filter(r => r.booted)).toHaveLength(1);
    const stored = await row(userId);
    expect(stored).toMatchObject({generation: 1, state: {status: 'ready', sandboxId: 'sb-1'}});
    const [sandbox] = modal.sandboxes;
    expect(sandbox!.spec).toMatchObject({
      volumeName: stored!.volumeName, mountPath: SANDBOX_VOLUME_MOUNT, name: sandboxName(stored!.volumeName, 1),
      idleTimeoutMs: SANDBOX_RESOURCES.IDLE_TIMEOUT_MS, timeoutMs: SANDBOX_RESOURCES.LIFETIME_MS,
    });
    expect(sandbox!.slot).toBe(stored!.slot === 1 ? CREDENTIALS.MODAL_TOKEN_ID : CREDENTIALS.MODAL_TOKEN_ID_2);
    expect(stored!.volumeName).not.toContain(userId);
    const again = await resolver.ensure(userId, 'workspace');
    expect(again).toMatchObject({sandboxId: 'sb-1', booted: false});
  });

  it('keeps owners apart and fails closed for a deleting owner or a missing server credential', async () => {
    const {t, rows, resolver, modal, owner, row} = setup();
    const [alice, bob] = await Promise.all([owner(), owner()]);
    const a = await resolver.ensure(alice, 'workspace');
    const b = await resolver.ensure(bob, 'workspace');
    remember([a.sandboxId, b.sandboxId]);
    expect(a.sandboxId).not.toBe(b.sandboxId);
    expect(a.port).not.toBe(b.port);
    expect((await row(alice))!.volumeName).not.toBe((await row(bob))!.volumeName);
    const aliceRow = (await row(alice))!;
    expect(await rows.release(bob, {scope: 'workspace', generation: aliceRow.generation + 1})).toBe(false);
    expect(await rows.commit(bob, {scope: 'workspace', generation: aliceRow.generation, sandboxId: a.sandboxId, expiresAtMs: Date.now() + 1})).toBe(false);
    expect(await row(alice)).toEqual(aliceRow);
    expect((await row(bob))!.state).toMatchObject({sandboxId: b.sandboxId});

    const deleting = await owner({deleting: true});
    await expect(resolver.ensure(deleting, 'workspace')).rejects.toThrow('Account unavailable');
    const claim = makeFunctionReference<'mutation'>(SANDBOX_FUNCTIONS.claim);
    await expect(t.mutation(claim, {serverToken: 'x'.repeat(40), userId: alice, request: {scope: 'workspace'}}))
      .rejects.toThrow('Server authentication required');
    expect(modal.creates).toBe(2);
  });

  it('marks a ready row terminated and boots on the same Volume when Modal lost the sandbox', async () => {
    const {resolver, modal, owner, row, logs} = setup();
    const userId = await owner();
    const first = await resolver.ensure(userId, 'workspace');
    const volumeName = (await row(userId))!.volumeName;
    modal.lose(first.sandboxId);
    const second = remember(await resolver.ensure(userId, 'workspace'));
    expect(second).toMatchObject({sandboxId: 'sb-2', booted: true});
    expect(modal.sandboxes[1]!.spec.volumeName).toBe(volumeName);
    expect(await row(userId)).toMatchObject({generation: 2, volumeName, state: {status: 'ready', sandboxId: 'sb-2'}});
    expect(logs.map(l => l.event)).toEqual(['sandbox.boot', 'sandbox.gone', 'sandbox.boot']);
    remember(logs);
  });

  it('releases the lock with a retryable error when boot dies halfway, then stops that writer before rebooting', async () => {
    const {resolver, modal, owner, row, logs} = setup();
    const userId = await owner();
    modal.failNextCreate = true;
    const before = Date.now();
    const error = remember(await failure(resolver.ensure(userId, 'workspace')));
    expect(error.detail).toMatchObject({code: 'unavailable', message: SANDBOX_MESSAGES.bootFailed});
    expect(error.detail.retryAtMs).toBeGreaterThan(before);
    expect((await row(userId))!.state).toEqual({status: 'terminated'});
    expect(logs.at(-1)).toMatchObject({event: 'sandbox.boot_failed', error: 'Error'});

    const next = await resolver.ensure(userId, 'workspace');
    expect(next).toMatchObject({sandboxId: 'sb-2', booted: true});
    expect(modal.terminated).toEqual(['sb-1']);
    expect(modal.live(modal.sandboxes[0]!.spec.volumeName).map(s => s.id)).toEqual(['sb-2']);
    remember(logs);
  });

  it('takes over an expired boot lease only after stopping the crashed booter', async () => {
    const {t, resolver, modal, owner, row, modalPool} = setup();
    const userId = await owner();
    const volumeName = `praxis-workspace-${'a'.repeat(32)}`;
    await modal.account(modalPool.slots[0]!.credential).create({
      name: sandboxName(volumeName, 1), volumeName, mountPath: SANDBOX_VOLUME_MOUNT,
      timeoutMs: 1, idleTimeoutMs: 1, cpu: 1, memoryMiB: 1, readyTimeoutMs: 1,
    });
    await t.run(ctx => ctx.db.insert('sandboxes', {
      userId, scope: 'workspace', slot: 1, volumeName, generation: 1,
      state: {status: 'booting', leaseExpiresAt: Date.now() - 1}, lastUsedAt: 0,
    }));
    const resolved = remember(await resolver.ensure(userId, 'workspace'));
    expect(resolved).toMatchObject({sandboxId: 'sb-2', booted: true});
    expect(modal.terminated).toEqual(['sb-1']);
    expect(await row(userId)).toMatchObject({generation: 2, state: {status: 'ready', sandboxId: 'sb-2'}});
  });

  it('waits for a live boot lease and reuses what its holder published', async () => {
    const {t, resolver, modal, owner, modalPool} = setup();
    const userId = await owner();
    const volumeName = `praxis-workspace-${'b'.repeat(32)}`;
    await t.run(ctx => ctx.db.insert('sandboxes', {
      userId, scope: 'workspace', slot: 1, volumeName, generation: 1,
      state: {status: 'booting', leaseExpiresAt: Date.now() + SANDBOX_LIFECYCLE.BOOT_LEASE_MS}, lastUsedAt: 0,
    }));
    const pending = resolver.ensure(userId, 'workspace');
    const holder = await modal.account(modalPool.slots[0]!.credential).create({
      name: sandboxName(volumeName, 1), volumeName, mountPath: SANDBOX_VOLUME_MOUNT,
      timeoutMs: 1, idleTimeoutMs: 1, cpu: 1, memoryMiB: 1, readyTimeoutMs: 1,
    });
    await t.run(async ctx => {
      const stored = await ctx.db.query('sandboxes').first();
      await ctx.db.patch(stored!._id, {state: {status: 'ready', sandboxId: holder, expiresAt: Date.now() + COOLING_MS}});
    });
    expect(remember(await pending)).toMatchObject({sandboxId: holder, booted: false});
    expect(modal.creates).toBe(1);
  });

  it('terminates its own sandbox when another writer fenced it out before commit', async () => {
    const {t, rows, resolverWith, modal, owner, row, logs} = setup();
    const userId = await owner();
    let interfered = false;
    const resolver = resolverWith({
      ...rows,
      async commit(owner, request) {
        if (!interfered) {
          interfered = true;
          await t.run(async ctx => {
            const stored = await ctx.db.query('sandboxes').first();
            await ctx.db.patch(stored!._id, {generation: stored!.generation + 1, state: {status: 'terminated'}});
          });
        }
        return rows.commit(owner, request);
      },
    });
    const resolved = remember(await resolver.ensure(userId, 'workspace'));
    expect(modal.terminated).toEqual(['sb-1']);
    expect(resolved).toMatchObject({sandboxId: 'sb-2', booted: true});
    expect(await row(userId)).toMatchObject({generation: 3});
    expect(logs.map(l => l.event)).toEqual(['sandbox.fenced', 'sandbox.boot']);
  });

  it('keeps a placed owner on its slot and reports a cooling slot as unavailable without naming it', async () => {
    const {resolver, modal, cooldowns, owner, row, logs} = setup();
    const userId = await owner();
    const first = await resolver.ensure(userId, 'workspace');
    const {slot} = (await row(userId))!;
    const until = Date.now() + COOLING_MS;
    await cooldowns.mark(MODAL_POOL.service, slot, {reason: 'exhausted', until});
    const error = remember(await failure(resolver.ensure(userId, 'workspace')));
    expect(error.detail).toMatchObject({code: 'unavailable', message: SANDBOX_MESSAGES.unavailable, retryAtMs: until});
    expect(JSON.stringify(error.detail)).not.toMatch(/slot|\d+\s*of|mov|fail ?over/i);
    expect(logs.at(-1)).toEqual({event: 'sandbox.unavailable', scope: 'workspace', slot, detail: 'cooling', retryAtMs: until});

    modal.lose(first.sandboxId);
    await failure(resolver.ensure(userId, 'workspace'));
    expect((await row(userId))!.slot).toBe(slot);
    expect(modal.creates).toBe(1);

    const newcomer = await owner();
    await resolver.ensure(newcomer, 'workspace');
    expect((await row(newcomer))!.slot).not.toBe(slot);
    remember(logs);
  });

  it('reports an unconfigured Modal pool as unavailable before writing any row', async () => {
    const {resolver, owner, row} = setup({});
    const userId = await owner();
    const error = remember(await failure(resolver.ensure(userId, 'workspace')));
    expect(error.detail).toMatchObject({code: 'unavailable', message: SANDBOX_MESSAGES.unavailable});
    expect(error.detail.retryAtMs).toBeUndefined();
    expect(await row(userId)).toBeNull();
  });

  it('parses Convex replies at the boundary', async () => {
    const rows = convexSandboxRows({mutation: async () => ({kind: 'ready', sandboxId: 'sb-1'})});
    await expect(rows.claim('user', {scope: 'workspace'})).rejects.toThrow();
  });
});
