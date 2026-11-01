import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../../../convex/schema.js';
import type { ConvexRPC } from '../convex.js';

export const TEST_SERVER_TOKEN = 'test-server-token-with-more-than-32-characters';

/** convex-test resolves the functions root from the `_generated` entry. */
const modules = {
  '../../../../../convex/_generated/api.js': async () => ({}),
  '../../../../../convex/account.ts': () => import('../../../../../convex/account.js'),
  '../../../../../convex/tools.ts': () => import('../../../../../convex/tools.js'),
  '../../../../../convex/store.ts': () => import('../../../../../convex/store.js'),
  '../../../../../convex/auth.ts': () => import('../../../../../convex/auth.js'),
  '../../../../../convex/files.ts': () => import('../../../../../convex/files.js'),
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
  return { t, rpc };
}
