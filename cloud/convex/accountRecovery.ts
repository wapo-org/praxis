import {
  ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER,
  AccountDeleteRecoverySchema,
  INTERNAL_CONTINUATION_PATH,
} from '@praxis/protocol';
import { SealedSecret } from '@praxis/types';
import { v } from 'convex/values';
import { internal } from './_generated/api.js';
import { internalAction, internalMutation } from './_generated/server.js';

export const ACCOUNT_DELETE_RETRY_MS = 60_000;

export const dispatch = internalMutation({
  args: { userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.userId))?.deleting) return null;
    // Convex actions are at-most-once, so commit the next attempt before making the HTTP call.
    await ctx.scheduler.runAfter(ACCOUNT_DELETE_RETRY_MS, internal.accountRecovery.dispatch, args);
    await ctx.scheduler.runAfter(0, internal.accountRecovery.deliver, args);
    return null;
  },
});

export const deliver = internalAction({
  args: { userId: v.id('users') },
  returns: v.null(),
  handler: async (_ctx, { userId }) => {
    const apiOrigin = new URL(process.env.PRAXIS_API_URL ?? '');
    const token = process.env.PRAXIS_CONVEX_SERVER_TOKEN;
    if (apiOrigin.protocol !== 'https:' || !token || token.length < 32) {
      throw new Error('Account deletion recovery is not configured');
    }
    const secret = SealedSecret.of(token);
    const body = JSON.stringify(AccountDeleteRecoverySchema.parse({ type: 'account.delete.resume', userId }));
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret.reveal()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const response = await fetch(new URL(INTERNAL_CONTINUATION_PATH, apiOrigin), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', [ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER]: signature },
      body,
    });
    if (!response.ok) throw new Error(`Account deletion recovery returned HTTP ${response.status}`);
    return null;
  },
});
