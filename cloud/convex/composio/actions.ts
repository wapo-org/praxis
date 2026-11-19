'use node';

import { deriveTenantId, SealedSecret } from '@praxis/types';
import { internalAction } from '../_generated/server.js';
import { internal } from '../_generated/api.js';
import { ConvexError, v } from 'convex/values';
import { composioFor } from './client.js';
import { COMPOSIO_ERRORS, TENANT_ID_SECRET_ENV } from './constants.js';
import { returnTarget } from './returnTarget.js';

const store = internal.composio.connectionStore;
const scope = { userId: v.string(), toolkit: v.string() };

export const connect = internalAction({
  args: { ...scope, returnTo: v.string() },
  handler: async (ctx, {userId, toolkit, returnTo}): Promise<string> => {
    const callbackUrl = returnTarget(returnTo, process.env);
    const secret = process.env[TENANT_ID_SECRET_ENV];
    if (!secret) throw new ConvexError(COMPOSIO_ERRORS.tenantSecretMissing);
    const tenantId = await deriveTenantId(userId, SealedSecret.of(secret));
    const client = composioFor(process.env);
    const target = {userId, toolkit};
    const attempt = await ctx.runMutation(store.beginConnect, target);
    if (attempt.status === 'unavailable') throw new ConvexError(COMPOSIO_ERRORS.accountUnavailable);
    if (attempt.status === 'reused') return attempt.redirectUrl;
    if (attempt.status === 'connected') throw new ConvexError(COMPOSIO_ERRORS.alreadyConnected);

    const {previousAccountId} = attempt;
    if (previousAccountId) await client.revokeConnection(previousAccountId);
    const link = await client.createConnectLink({tenantId, toolkit, callbackUrl});
    const result = await ctx.runMutation(store.store, {...target, ...link, previousAccountId});
    if (result.status === 'saved') return result.redirectUrl;

    await client.revokeConnection(link.connectedAccountId);
    if (result.status === 'reused') return result.redirectUrl;
    if (result.status === 'unavailable') throw new ConvexError(COMPOSIO_ERRORS.accountUnavailable);
    throw new ConvexError(COMPOSIO_ERRORS.connectionChanged);
  },
});

export const disconnect = internalAction({
  args: scope,
  handler: async (ctx, target): Promise<null> => {
    const client = composioFor(process.env);
    const connection = await ctx.runQuery(store.get, target);
    if (!connection.active) throw new ConvexError(COMPOSIO_ERRORS.accountUnavailable);
    if (!connection.row) return null;

    const {connectedAccountId} = connection.row;
    await client.revokeConnection(connectedAccountId);
    await ctx.runMutation(store.remove, {...target, connectedAccountId});
    return null;
  },
});
