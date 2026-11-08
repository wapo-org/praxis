import { v, ConvexError } from 'convex/values';
import { mutation } from './functions.js';
import { requireServer } from './access.js';

/** Atomic identity binding: a verified Clerk email retains the legacy user's id and every owned row. */
export const resolve = mutation({
  args: { serverToken: v.string(), identity: v.object({ id: v.string(), email: v.string(), verified: v.boolean(), name: v.string() }) },
  handler: async (ctx, { serverToken, identity }) => {
    await requireServer(serverToken);
    if (!identity.verified || !identity.email) throw new ConvexError('Verified email required');
    const accounts = await ctx.db.query('authDocuments').withIndex('model', q => q.eq('model', 'account')).collect();
    const bound = accounts.find(a => a.data.providerId === 'clerk' && a.data.accountId === identity.id);
    if (bound) return { userId: bound.data.userId as string };
    const email = identity.email.trim().toLowerCase();
    const users = await ctx.db.query('authDocuments').withIndex('model', q => q.eq('model', 'user')).collect();
    const matches = users.filter(u => String(u.data.email).trim().toLowerCase() === email);
    if (matches.length > 1 || matches[0]?.data.deleting) throw new ConvexError('Account unavailable');
    const legacy = matches[0];
    if (legacy && accounts.some(a => a.data.providerId === 'clerk' && a.data.userId === legacy.id)) throw new ConvexError('Email already bound');
    const userId = legacy?.id ?? identity.id;
    if (!legacy) await ctx.db.insert('authDocuments', { model: 'user', id: userId, data: { id: userId, email, emailVerified: true, name: identity.name, createdAt: new Date().toISOString() } });
    const id = `clerk:${identity.id}`;
    await ctx.db.insert('authDocuments', { model: 'account', id, data: { id, providerId: 'clerk', accountId: identity.id, userId } });
    return { userId };
  },
});
