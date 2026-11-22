import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../../../convex/schema.js';
import type { ConvexRPC } from '../convex.js';

export const TEST_SERVER_TOKEN = 'test-server-token-with-more-than-32-characters';

/** convex-test resolves the functions root from the `_generated` entry. */
const modules = {
  '../../../../../convex/webTools.ts': () => import('../../../../../convex/webTools.js'),
  '../../../../../convex/_generated/api.js': async () => ({}),
  '../../../../../convex/accountRecovery.ts': () => import('../../../../../convex/accountRecovery.js'),
  '../../../../../convex/account.ts': () => import('../../../../../convex/account.js'),
  '../../../../../convex/tools.ts': () => import('../../../../../convex/tools.js'),
  '../../../../../convex/messages.ts': () => import('../../../../../convex/messages.js'),
  '../../../../../convex/store.ts': () => import('../../../../../convex/store.js'),
  '../../../../../convex/files.ts': () => import('../../../../../convex/files.js'),
  '../../../../../convex/search.ts': () => import('../../../../../convex/search.js'),
  '../../../../../convex/functions.ts': () => import('../../../../../convex/functions.js'),
};

/** Executable Convex database (convex-test) behind the same RPC shape as `createConvexRPC`. */
export function convexHarness(serverToken = TEST_SERVER_TOKEN) {
  process.env.PRAXIS_CONVEX_SERVER_TOKEN = TEST_SERVER_TOKEN;
  process.env.CONVEX_SITE_URL ??= 'https://happy-otter-123.convex.site';
  const t = convexTest(schema, modules);
  const rpc: ConvexRPC = {
    query: (name, args) => t.query(makeFunctionReference<'query'>(name), { ...args, serverToken }),
    mutation: (name, args) => t.mutation(makeFunctionReference<'mutation'>(name), { ...args, serverToken }),
    action: (name, args) => t.action(makeFunctionReference<'action'>(name), { ...args, serverToken }),
  };
  const owner = () => t.run(ctx => ctx.db.insert('users', {}));
  return { t, rpc, owner };
}

/** Maps fixed test owner labels (such as dev-local `local-user`) to minted `users` rows, as production owners are. */
export function aliasOwners(rpc: ConvexRPC, owner: () => Promise<string>): ConvexRPC {
  const minted = new Map<string, Promise<string>>();
  const resolve = (label: string) => {
    if (!minted.has(label)) minted.set(label, owner());
    return minted.get(label)!;
  };
  const withOwner = async (args: Record<string, unknown>) => {
    return typeof args.userId === 'string' ? { ...args, userId: await resolve(args.userId) } : args;
  };
  return {
    query: async (name, args) => rpc.query(name, await withOwner(args)),
    mutation: async (name, args) => rpc.mutation(name, await withOwner(args)),
    action: async (name, args) => rpc.action(name, await withOwner(args)),
  };
}
