import { expect, it } from 'vitest';
import { blobOwnerTag } from '../../../../convex/blob-owner.js';
import { convexHarness } from '../adapters/testing/convex-harness.js';

it('continues the global blob sweep across retried requests instead of restarting it', async () => {
  const { t, rpc } = convexHarness();
  const tag = await blobOwnerTag('u');
  await t.run(async (ctx) => {
    await ctx.db.insert('authDocuments', { model: 'user', id: 'u', data: { id: 'u', email: 'u@example.test' } });
    for (let i = 0; i < 250; i++) await ctx.storage.store(new Blob([`other ${i}`], { type: 'text/plain' }));
    await ctx.storage.store(new Blob(['mine'], { type: `text/plain;${tag}` }));
  });
  await rpc.mutation('account:begin', { userId: 'u' });
  // Every call is a fresh request that has lost its in-memory cursor; each must still make progress.
  let calls = 0;
  while (!((await rpc.mutation('account:purge', { userId: 'u' })) as { done: boolean }).done)
    expect(++calls).toBeLessThan(6);
  await t.run(async (ctx) => {
    const blobs = await ctx.db.system.query('_storage').collect();
    expect(blobs).toHaveLength(250);
    expect(blobs.some((b) => b.contentType?.includes(tag))).toBe(false);
    expect(await ctx.db.query('authDocuments').collect()).toEqual([]);
  });
});
