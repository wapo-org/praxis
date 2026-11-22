import { z } from 'zod';
import type { ConvexRPC } from './adapters/convex.js';
import type { accountRedis } from './adapters/account-redis.js';

/** Strict, so a legacy or malformed account:purge reply fails closed instead of looping on `done: undefined`. */
const PurgeBatchSchema = z.strictObject({
  done: z.boolean(),
  blobCursor: z.string().min(1).optional(),
  blobsDone: z.boolean().optional(),
});

// Callers map any throw to a retryable failure; the reply itself is never echoed.
async function purgeBatch(rpc: ConvexRPC, args: Record<string, unknown>) {
  const parsed = PurgeBatchSchema.safeParse(await rpc.mutation('account:purge', args));
  if (!parsed.success) throw new Error('account:purge returned an unexpected result');
  return parsed.data;
}

/** Lock activation against deletion; after freeze all owner Redis writes fail closed. */
export function accountEraser(
  rpc: ConvexRPC,
  ownership: ReturnType<typeof accountRedis>,
) {
  async function purge(userId: string) {
    await ownership.freeze(userId);
    await ownership.purge(userId);
    let blobCursor: string | undefined;
    let blobsDone = false;
    for (;;) {
      const result = await purgeBatch(rpc, {
        userId,
        ...(blobCursor ? {blobCursor} : {}),
        ...(blobsDone ? {blobsDone} : {}),
      });
      if (result.done) return;
      blobCursor = result.blobCursor ?? blobCursor;
      blobsDone = result.blobsDone ?? blobsDone;
    }
  }

  return Object.assign(
    async (userId: string, sessionId: string) => {
      await ownership.exclusive(userId, async () => {
        await rpc.mutation('account:begin', {userId, keepSessionId: sessionId});
        await purge(userId);
      });
    },
    {
      async resume(userId: string) {
        await ownership.exclusive(userId, async () => {
          if (await rpc.query('account:pending', {userId}) === true) await purge(userId);
        });
      },
    },
  );
}
