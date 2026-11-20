import { v } from 'convex/values';
import { z } from 'zod';
import {
  ComposioConnectedAccountsSchema, ComposioOwnerRequestSchema, ComposioUsageRequestSchema, type ComposioConnectedAccount,
} from '@praxis/protocol';
import { requireServer } from '../access.js';
import { activeOwner } from '../accountOwner.js';
import { mutation, query, type MutationCtx } from '../functions.js';
import { convexValidator } from '../zodValidator.js';

// Server-token RPC for the API's Tool Router (PRA-48); the owner arrives only inside the server-signed request.
const EXECUTION_KIND = 'composioExecution';
const USAGE_KIND = 'composioUsage';
const Encoded = z.object({ encoded: z.string() });
const UsageCount = z.object({ executions: z.number().int().nonnegative() });

export const connectedAccounts = query({
  args: { serverToken: v.string(), request: convexValidator(ComposioOwnerRequestSchema) },
  handler: async (ctx, args): Promise<ComposioConnectedAccount[]> => {
    await requireServer(args.serverToken);
    const { userId } = ComposioOwnerRequestSchema.parse(args.request);
    if (!await activeOwner(ctx, userId)) return [];
    const rows = await ctx.db.query('connections')
      .withIndex('by_user_toolkit', q => q.eq('userId', userId))
      .collect();
    return ComposioConnectedAccountsSchema.parse(rows
      .filter(row => row.status === 'connected')
      .map(row => ({ toolkit: row.toolkit, connectedAccountId: row.connectedAccountId })));
  },
});

function toolState(ctx: MutationCtx, userId: string, kind: string, id: string) {
  return ctx.db.query('toolState')
    .withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id))
    .unique();
}

/** Counts a batch's executions once per run/call, so replaying a turn never double counts. */
export const recordUsage = mutation({
  args: { serverToken: v.string(), request: convexValidator(ComposioUsageRequestSchema) },
  handler: async (ctx, args): Promise<null> => {
    await requireServer(args.serverToken);
    const request = ComposioUsageRequestSchema.parse(args.request);
    if (!await activeOwner(ctx, request.userId)) throw new Error('Account unavailable');
    const callKey = JSON.stringify([request.runId, request.callId]);
    if (await toolState(ctx, request.userId, EXECUTION_KIND, callKey)) return null;
    await ctx.db.insert('toolState', {
      userId: request.userId, kind: EXECUTION_KIND, id: callKey,
      value: { encoded: JSON.stringify({ period: request.period, executions: request.executions }) },
    });
    const usage = await toolState(ctx, request.userId, USAGE_KIND, request.period);
    const previous = usage ? UsageCount.parse(JSON.parse(Encoded.parse(usage.value).encoded)).executions : 0;
    const value = { encoded: JSON.stringify({ executions: previous + request.executions }) };
    if (usage) await ctx.db.patch(usage._id, { value });
    else await ctx.db.insert('toolState', { userId: request.userId, kind: USAGE_KIND, id: request.period, value });
    return null;
  },
});
