import {afterEach, describe, expect, it, vi} from 'vitest';
import {v} from 'convex/values';
import {authedAction, type ActionCtx} from '../convex/functions.js';

function actionContext(options: {authenticated: boolean; active: boolean}): ActionCtx {
  let queryCount = 0;
  const runQuery = async (_reference: unknown, _args: unknown): Promise<unknown> => {
    queryCount += 1;
    return queryCount === 1 ? {userId: 'owner'} : options.active;
  };
  return {
    auth: {
      getUserIdentity: async () => options.authenticated ? {subject: 'session'} : null,
    },
    runQuery,
  } as unknown as ActionCtx;
}

describe('authenticated Convex wrappers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('injects the verified owner and rejects an owner whose account is deleting', async () => {
    const readOwner = authedAction({
      args: {},
      handler: async (_ctx, args) => (args as {userId: string}).userId,
    });

    await expect(readOwner._handler(actionContext({authenticated: true, active: true}), {})).resolves.toBe('owner');
    await expect(readOwner._handler(actionContext({authenticated: true, active: false}), {})).rejects.toThrow('Account unavailable');
  });

  it('rejects an unauthenticated action before owner lookup', async () => {
    const action = authedAction({args: {value: v.string()}, handler: async () => 'ok'});
    await expect(action._handler(actionContext({authenticated: false, active: true}), {value: 'input'})).rejects.toThrow('Authentication required');
  });
});
