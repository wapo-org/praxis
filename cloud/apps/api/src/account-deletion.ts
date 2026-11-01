import type { ConvexRPC } from './adapters/convex.js';
import type { accountRedis } from './adapters/account-redis.js';
/** Lock activation against deletion; after freeze all owner Redis writes fail closed. */
export function accountEraser(rpc: ConvexRPC, ownership: ReturnType<typeof accountRedis>) {
  return (userId: string, sessionId: string) =>
    ownership.exclusive(userId, async () => {
      await rpc.mutation('account:begin', { userId });
      await ownership.freeze(userId);
      await ownership.purge(userId);
      // Keep the caller's session and password credential until the final atomic batch: interrupted work can retry.
      let blobCursor: string | undefined,
        blobsDone = false;
      for (;;) {
        const result = (await rpc.mutation('account:purge', {
          userId,
          keepSessionId: sessionId,
          ...(blobCursor ? { blobCursor } : {}),
          ...(blobsDone ? { blobsDone } : {}),
        })) as { done: boolean; blobCursor?: string; blobsDone?: boolean };
        if (result.done) return;
        blobCursor = result.blobCursor ?? blobCursor;
        blobsDone = result.blobsDone ?? blobsDone;
      }
    });
}
