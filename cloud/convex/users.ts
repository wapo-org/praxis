import { AUTH_EMAIL_METHOD_CONFLICT } from '@praxis/protocol';
import { v, ConvexError } from 'convex/values';
import { vGoogleProfile } from '@convex-dev/auth/methods/google/server';
import { vAppleProfile } from '@convex-dev/auth/methods/apple/server';
import { internalMutation } from './_generated/server.js';
import { components } from './_generated/api.js';
import type { MutationCtx } from './_generated/server.js';
import { activeOwner } from './accountOwner.js';

async function assertOwnerCanSignIn(ctx: MutationCtx, userId: string): Promise<void> {
  if (!await activeOwner(ctx, userId)) throw new ConvexError('Account unavailable');
}

async function createOAuthUser(ctx: MutationCtx, email?: string) {
  // Reject shared emails instead of silently creating duplicate identities or linking unproven accounts.
  if (email) {
    const existing = await ctx.runMutation(components.authEmail.verifiedEmails.lookupEmail, { email });
    if (existing.success) throw new ConvexError(AUTH_EMAIL_METHOD_CONFLICT);
    if (existing.userError.error !== 'EMAIL_NOT_FOUND') throw new ConvexError(existing.userError.error);
  }
  const normalizedEmail = email?.toLowerCase().normalize('NFC');
  if (normalizedEmail && await ctx.db.query('oauthEmails').withIndex('email', q => q.eq('email', normalizedEmail)).unique()) {
    throw new ConvexError(AUTH_EMAIL_METHOD_CONFLICT);
  }
  const userId = await ctx.db.insert('users', {});
  if (email) {
    await ctx.db.insert('oauthEmails', { userId, email: normalizedEmail! });
  }
  return userId;
}
export const createUser = internalMutation({
  args: { method: v.object({ name: v.literal('emailPassword'), profile: v.object({}) }) },
  returns: v.id('users'),
  handler: ctx => ctx.db.insert('users', {}),
});
export const createUserGoogle = internalMutation({
  args: { method: v.object({ name: v.literal('google'), profile: vGoogleProfile }) },
  returns: v.id('users'),
  handler: (ctx, { method }) => createOAuthUser(ctx, method.profile.emailVerified ? method.profile.email : undefined),
});
export const createUserApple = internalMutation({
  args: { method: v.object({ name: v.literal('apple'), profile: vAppleProfile }) },
  returns: v.id('users'),
  handler: (ctx, { method }) => createOAuthUser(ctx, method.profile.emailVerified ? method.profile.email : undefined),
});

export const onEmailSignIn = internalMutation({
  args: {
    method: v.object({ name: v.literal('emailPassword'), profile: v.object({}) }),
    userId: v.id('users'),
  },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    await assertOwnerCanSignIn(ctx, userId);
    const emails = await ctx.runQuery(components.authEmail.verifiedEmails.getEmails, { userId });
    for (const { email } of emails) {
      const normalized = email.toLowerCase().normalize('NFC');
      if (await ctx.db.query('oauthEmails').withIndex('email', q => q.eq('email', normalized)).unique()) {
        throw new ConvexError(AUTH_EMAIL_METHOD_CONFLICT);
      }
    }
    return null;
  },
});

export const onOAuthSignInGoogle = internalMutation({
  args: {
    method: v.object({ name: v.literal('google'), profile: vGoogleProfile }),
    userId: v.id('users'),
  },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    await assertOwnerCanSignIn(ctx, userId);
    return null;
  },
});

export const onOAuthSignInApple = internalMutation({
  args: {
    method: v.object({ name: v.literal('apple'), profile: vAppleProfile }),
    userId: v.id('users'),
  },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    await assertOwnerCanSignIn(ctx, userId);
    return null;
  },
});
