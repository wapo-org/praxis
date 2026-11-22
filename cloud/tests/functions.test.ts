import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {OWNER_ERRORS} from '@praxis/protocol';
import {ConvexError, v} from 'convex/values';
import {
  authedAction,
  authedMutation,
  authedQuery,
  serverAccountMutation,
  serverMutation,
  serverQuery,
  type ActionCtx,
  type MutationCtx,
} from '../convex/functions.js';

const SERVER_TOKEN = 'server-token-with-more-than-thirty-two-characters';
const SESSION_OWNER = 'owner';

type Owners = Record<string, {deleting: boolean}>;

/** Enough of a query/mutation ctx for the wrappers: a session lookup and the `users` rows. */
function databaseContext(options: {authenticated: boolean; owners: Owners}): MutationCtx {
  return {
    auth: {getUserIdentity: async () => options.authenticated ? {subject: 'session'} : null},
    runQuery: async () => ({userId: SESSION_OWNER}),
    db: {
      normalizeId: (_table: string, id: string) => id in options.owners ? id : null,
      get: async (id: string) => options.owners[id] ?? null,
    },
  } as unknown as MutationCtx;
}

function actionContext(options: {authenticated: boolean; active: boolean}): ActionCtx {
  let queryCount = 0;
  const runQuery = async (_reference: unknown, _args: unknown): Promise<unknown> => {
    queryCount += 1;
    return queryCount === 1 ? {userId: SESSION_OWNER} : options.active;
  };
  return {
    auth: {getUserIdentity: async () => options.authenticated ? {subject: 'session'} : null},
    runQuery,
  } as unknown as ActionCtx;
}

async function errorCode(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(() => null, (caught: unknown) => caught);
  return error instanceof ConvexError ? (error.data as {code?: unknown}).code : error;
}

const active: Owners = {[SESSION_OWNER]: {deleting: false}, other: {deleting: false}};
const deleting: Owners = {[SESSION_OWNER]: {deleting: true}};

describe('authenticated Convex wrappers', () => {
  it('injects the verified owner and rejects an owner whose account is deleting', async () => {
    const readOwner = authedAction({args: {}, handler: async (_ctx, {userId}) => userId});

    await expect(readOwner._handler(actionContext({authenticated: true, active: true}), {})).resolves.toBe(SESSION_OWNER);
    const fenced = readOwner._handler(actionContext({authenticated: true, active: false}), {});
    expect(await errorCode(fenced)).toBe(OWNER_ERRORS.accountUnavailable.code);
  });

  it('throws a typed unauthenticated error before the owner lookup', async () => {
    const action = authedAction({args: {value: v.string()}, handler: async () => 'ok'});
    const signedOut = action._handler(actionContext({authenticated: false, active: true}), {value: 'input'});
    expect(await errorCode(signedOut)).toBe(OWNER_ERRORS.unauthenticated.code);

    const query = authedQuery({args: {}, handler: async () => 'ok'});
    const anonymous = query._handler(databaseContext({authenticated: false, owners: active}), {});
    expect(await errorCode(anonymous)).toBe(OWNER_ERRORS.unauthenticated.code);
  });

  it('overrides any owner a caller smuggles past the validator with the session owner', async () => {
    const query = authedQuery({args: {chatId: v.string()}, handler: async (_ctx, args) => args});
    const smuggled = {chatId: 'c', userId: 'other'} as {chatId: string};
    await expect(query._handler(databaseContext({authenticated: true, owners: active}), smuggled))
      .resolves.toEqual({chatId: 'c', userId: SESSION_OWNER});

    const mutation = authedMutation({args: {}, handler: async (_ctx, {userId}) => userId});
    const fenced = mutation._handler(databaseContext({authenticated: true, owners: deleting}), {});
    expect(await errorCode(fenced)).toBe(OWNER_ERRORS.accountUnavailable.code);
  });
});

describe('server Convex wrappers', () => {
  beforeEach(() => {
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares the token and owner, verifies the token and never hands the token to the handler', async () => {
    const read = serverQuery({args: {id: v.string()}, handler: async (_ctx, args) => args});
    expect(Object.keys(JSON.parse(read.exportArgs()).value).sort()).toEqual(['id', 'serverToken', 'userId']);

    const ctx = databaseContext({authenticated: false, owners: active});
    await expect(read._handler(ctx, {id: 'x', serverToken: SERVER_TOKEN, userId: 'other'}))
      .resolves.toEqual({id: 'x', userId: 'other'});
    await expect(read._handler(ctx, {id: 'x', serverToken: 'x'.repeat(48), userId: 'other'}))
      .rejects.toThrow('Server authentication required');
    await expect(read._handler(ctx, {id: 'x', serverToken: SERVER_TOKEN, userId: ''})).rejects.toThrow('Invalid scope');
  });

  it('fences worker writes for a deleting owner, except the account deletion lifecycle', async () => {
    const args = {serverToken: SERVER_TOKEN, userId: SESSION_OWNER};
    const ctx = databaseContext({authenticated: false, owners: deleting});
    const read = serverQuery({args: {}, handler: async (_ctx, {userId}) => userId});
    const write = serverMutation({args: {}, handler: async (_ctx, {userId}) => userId});
    const purge = serverAccountMutation({args: {}, handler: async (_ctx, {userId}) => userId});

    await expect(read._handler(ctx, args)).resolves.toBe(SESSION_OWNER);
    expect(await errorCode(write._handler(ctx, args))).toBe(OWNER_ERRORS.accountUnavailable.code);
    await expect(purge._handler(ctx, args)).resolves.toBe(SESSION_OWNER);
  });
});
