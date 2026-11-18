import type { ConvexRPC } from './adapters/convex.js';
import type { accountRedis } from './adapters/account-redis.js';

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
      const result = (await rpc.mutation('account:purge', {
        userId,
        ...(blobCursor ? {blobCursor} : {}),
        ...(blobsDone ? {blobsDone} : {}),
      })) as {done: boolean; blobCursor?: string; blobsDone?: boolean};
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
