import {describe, expect, it} from 'vitest';
import {accountEraser} from '../account-deletion.js';
import type {ConvexRPC} from '../adapters/convex.js';
import {fakeRedis} from '../adapters/testing/fake-redis.js';
import {upstashFromRedis} from '../adapters/upstash.js';

const USER = 'owner-1';

/** Scripted `account:purge` replies; `pending` mirrors Convex keeping the owner pending until a batch reports done. */
function scriptedConvex(replies: unknown[]) {
  const purges: Record<string, unknown>[] = [];
  let pending = false;
  const rpc: ConvexRPC = {
    async query(name) {
      if (name !== 'account:pending') throw new Error(`unexpected query ${name}`);
      return pending;
    },
    async mutation(name, args) {
      if (name === 'account:begin') {
        pending = true;
        return null;
      }
      if (name !== 'account:purge') throw new Error(`unexpected mutation ${name}`);
      purges.push(args);
      const reply = replies.shift();
      if (reply && typeof reply === 'object' && 'done' in reply && reply.done === true) pending = false;
      return reply;
    },
    async action(name) {
      throw new Error(`unexpected action ${name}`);
    },
  };
  return {rpc, purges, replies};
}

async function activeOwner() {
  const memory = fakeRedis();
  const redis = upstashFromRedis(memory.redis, {accountOwnership: true, clock: memory.now});
  await redis.ownership.activate(USER);
  await redis.kv.set('owner-cache', {cached: true}, 60, USER);
  return redis;
}

describe('account eraser parses every account:purge reply at the Convex boundary', () => {
  it.each([
    ['an empty legacy reply', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a string done flag', {done: 'true'}],
    ['the retired retainClerk handshake', {done: false, ready: true, blobsDone: true}],
    ['an empty blob cursor', {done: false, blobCursor: ''}],
    ['a numeric blob cursor', {done: false, blobCursor: 7}],
    ['an array', []],
    ['an unknown field', {done: false, leaked: 'reply-secret-value'}],
  ])('fails closed on %s after one batch, with Redis frozen and the deletion resumable', async (_label, malformed) => {
    const redis = await activeOwner();
    const convex = scriptedConvex([malformed]);
    const erase = accountEraser(convex.rpc, redis.ownership);

    const failure = erase(USER, 'session-1');
    await expect(failure).rejects.toThrow(/^account:purge returned an unexpected result$/);
    await failure.catch((error: Error) => {
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain('reply-secret-value');
    });
    expect(convex.purges).toHaveLength(1);
    expect(await redis.ownership.isActive(USER)).toBe(false);
    expect(await redis.kv.get('owner-cache')).toBeNull();
    await expect(redis.kv.set('stale-write', {}, 60, USER)).rejects.toThrow('Account unavailable');

    convex.replies.push({done: false, blobCursor: 'cursor-1'}, {done: true});
    await erase.resume(USER);
    expect(convex.purges.slice(1)).toEqual([{userId: USER}, {userId: USER, blobCursor: 'cursor-1'}]);
    expect(await convex.rpc.query('account:pending', {userId: USER})).toBe(false);
  });

  it('threads well-formed batch progress until done', async () => {
    const redis = await activeOwner();
    const convex = scriptedConvex([
      {done: false},
      {done: false, blobCursor: 'cursor-1'},
      {done: false, blobsDone: true},
      {done: true},
    ]);
    await accountEraser(convex.rpc, redis.ownership)(USER, 'session-1');
    expect(convex.purges).toEqual([
      {userId: USER},
      {userId: USER},
      {userId: USER, blobCursor: 'cursor-1'},
      {userId: USER, blobCursor: 'cursor-1', blobsDone: true},
    ]);
  });
});
