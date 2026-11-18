import type { ConvexRPC } from './adapters/convex.js';
import type { accountRedis } from './adapters/account-redis.js';
/** Lock activation against deletion; after freeze all owner Redis writes fail closed. */
export function accountEraser(rpc: ConvexRPC, ownership: ReturnType<typeof accountRedis>, deleteExternal?: (userId: string) => Promise<void>) {
  return (userId: string, sessionId: string) =>
    ownership.exclusive(userId, async () => {
      await rpc.mutation('account:begin', { userId, keepSessionId: sessionId });
      await ownership.freeze(userId);
      await ownership.purge(userId);
      // Keep the initiating session until the final batch so an interrupted erasure can retry.
      let blobCursor: string | undefined,
        blobsDone = false, externalDone = !deleteExternal;
      for (;;) {
        const result = (await rpc.mutation('account:purge', {
          userId,
          keepSessionId: sessionId,
          ...(externalDone ? {} : {retainClerk: true}),
          ...(blobCursor ? { blobCursor } : {}),
          ...(blobsDone ? { blobsDone } : {}),
        })) as { done: boolean; ready?: boolean; blobCursor?: string; blobsDone?: boolean };
        if (result.done) return;
        if (result.ready && !externalDone) { await deleteExternal!(userId); externalDone = true; }
        blobCursor = result.blobCursor ?? blobCursor;
        blobsDone = result.blobsDone ?? blobsDone;
      }
    });
}
