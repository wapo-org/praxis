import { registerCore } from '@convex-dev/auth/test';
import {registerEmail} from '@convex-dev/auth/components/email/test';
import {registerPassword} from '@convex-dev/auth/components/password/test';
import {registerGoogleOauth} from '@convex-dev/auth/components/google/test';
import { expect, it } from 'vitest';
import { blobOwnerTag } from '../convex/blobOwner.js';
import { convexHarness } from '../apps/api/src/adapters/testing/convex-harness.js';

it('resumes the Convex Auth owner blob sweep across retried requests', async () => {
  const { t, rpc } = convexHarness();
  for (const register of [registerCore, registerEmail, registerPassword, registerGoogleOauth]) register(t);
  const userId = await t.run(ctx => ctx.db.insert('users', {}));
  const tag = await blobOwnerTag(userId);
  await t.run(async (ctx) => {
    for (let i = 0; i < 250; i++) await ctx.storage.store(new Blob([`other ${i}`], { type: 'text/plain' }));
    await ctx.storage.store(new Blob(['mine'], { type: `text/plain;${tag}` }));
  });
  await rpc.mutation('account:begin', { userId });
  // Stateless calls without an in-memory cursor must still make progress.
  let calls = 0;
  while (!((await rpc.mutation('account:purge', { userId })) as { done: boolean }).done)
    expect(++calls).toBeLessThan(6);
  await t.run(async (ctx) => {
    const blobs = await ctx.db.system.query('_storage').collect();
    expect(blobs).toHaveLength(250);
    expect(blobs.some((b) => b.contentType?.includes(tag))).toBe(false);
    expect(await ctx.db.get(userId)).toBeNull();
  });
});
