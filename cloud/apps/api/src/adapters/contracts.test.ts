import { describe, expect, it } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { createMemoryAdapters } from './memory.js';
import { createConvexStore, storeFromRPC } from './convex.js';
import { convexHarness } from './testing/convex-harness.js';
import { eventsContract, kvContract, storeContract } from './testing/contract-suite.js';

storeContract('Store contract: memory', () => createMemoryAdapters().store);
kvContract('KV contract: memory', () => createMemoryAdapters().kv, { realTime: true });
eventsContract('Events contract: memory', () => createMemoryAdapters().events);

storeContract('Store contract: Convex functions (convex-test database)', () => storeFromRPC(convexHarness().rpc));

describe('Convex server boundary', () => {
  it('rejects missing or wrong server credentials before touching rows', async () => {
    const { t } = convexHarness();
    const reads: [string, Record<string, unknown>][] = [
      ['store:get', { userId: 'a', kind: 'chat', id: 'x' }],
      ['store:list', { userId: 'a', kind: 'chat' }],
      ['store:changes', { userId: 'a', after: 0, limit: 10 }],
      ['store:head', { userId: 'a' }],
      ['auth:read', { operation: 'findOne', input: { model: 'user' } }],
    ];
    for (const [name, args] of reads) {
      await expect(t.query(makeFunctionReference<'query'>(name), { ...args, serverToken: 'wrong' })).rejects.toThrow(
        'Server authentication',
      );
    }
    await expect(
      t.mutation(makeFunctionReference<'mutation'>('store:put'), {
        userId: 'a',
        kind: 'chat',
        id: 'x',
        value: {},
        serverToken: 'x'.repeat(48),
      }),
    ).rejects.toThrow('Server authentication');
    const { rpc } = convexHarness('a-forged-token-that-is-long-enough-to-pass-length');
    await expect(storeFromRPC(rpc).head('a')).rejects.toThrow('Server authentication');
  });

  it('fails closed when the deployment has no (or a short) server token configured', async () => {
    const { rpc } = convexHarness();
    process.env.PRAXIS_CONVEX_SERVER_TOKEN = 'short';
    await expect(storeFromRPC(rpc).get('a', 'chat', 'x')).rejects.toThrow('Server authentication');
  });

  it('validates pagination and JSON at the API adapter boundary', async () => {
    const store = storeFromRPC(convexHarness().rpc);
    await expect(store.changes('a', -1, 5)).rejects.toThrow();
    await expect(store.changes('a', 0, 5000)).rejects.toThrow();
    await expect(store.put('a', 'chat', '', {})).rejects.toThrow();
    await expect(store.put('a', 'chat', 'x', { invalid: undefined } as never)).rejects.toThrow();
  });

  it('compare-and-set writes reject stale revisions', async () => {
    const store = storeFromRPC(convexHarness().rpc);
    const first = await store.putIfRevision('a', 'checkpoint', 'r', { v: 1 }, 0);
    expect(first?.value).toEqual({ v: 1 });
    expect(await store.putIfRevision('a', 'checkpoint', 'r', { v: 9 }, 0)).toBeNull();
    const second = await store.putIfRevision('a', 'checkpoint', 'r', { v: 2 }, first!.revision);
    expect(second?.value).toEqual({ v: 2 });
    expect(await store.putIfRevision('a', 'checkpoint', 'r', { v: 9 }, first!.revision)).toBeNull();
    expect((await store.get('a', 'checkpoint', 'r'))?.value).toEqual({ v: 2 });
  });
});

const liveConvex = !!(process.env.PRAXIS_TEST_CONVEX_URL && process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN);
if (!liveConvex) {
  console.info('[contracts] live Convex suite skipped: set PRAXIS_TEST_CONVEX_URL and PRAXIS_TEST_CONVEX_SERVER_TOKEN');
}
describe.skipIf(!liveConvex)('live Convex deployment', () => {
  storeContract('Store contract: live Convex', () =>
    createConvexStore({
      url: process.env.PRAXIS_TEST_CONVEX_URL!,
      serverToken: process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN!,
    }),
  );
});
