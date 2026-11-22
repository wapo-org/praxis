import {internal} from '../_generated/api.js';
import {internalMutation, internalQuery} from '../functions.js';
import {ConvexError, v} from 'convex/values';
import {
  CONTEXT_ITEMS_PER_USER_MAX,
  CONTEXT_SHARED_OWNER,
  CONTEXT_SUMMARY_MAX_CHARACTERS,
} from './constants.js';

const itemArgs = {
  userId: v.string(), kind: v.string(), key: v.string(), title: v.string(), summary: v.string(),
  searchText: v.string(), version: v.string(), tainted: v.boolean(), taintSource: v.optional(v.string()), chatId: v.optional(v.string()),
};

export const upsertItem = internalMutation({
  args: itemArgs,
  handler: async (ctx, args) => {
    if (!args.userId || args.userId.length > 500 || args.userId === CONTEXT_SHARED_OWNER && !args.kind) throw new ConvexError('Invalid context owner');
    const [kind, key, title, searchText, version] = [args.kind, args.key, args.title, args.searchText, args.version];
    if (!kind || kind.length > 80 || !key || key.length > 300 || !title || title.length > 300 || !version || version.length > 100) {
      throw new ConvexError('Invalid context item');
    }
    const summary = Array.from(args.summary).slice(0, CONTEXT_SUMMARY_MAX_CHARACTERS).join('');
    if (!summary || searchText.length > 20_000 || args.taintSource && args.taintSource.length > 200 || args.chatId && args.chatId.length > 500) {
      throw new ConvexError('Invalid context content');
    }
    const hashInput = JSON.stringify({kind, key, title, summary, searchText, version, tainted: args.tainted, taintSource: args.taintSource, chatId: args.chatId});
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
    const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const prior = await ctx.db.query('contextItems').withIndex('owner_kind_key', q => q.eq('userId', args.userId).eq('kind', kind).eq('key', key)).unique();
    if (!prior) {
      const owned = await ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', args.userId)).take(CONTEXT_ITEMS_PER_USER_MAX + 1);
      if (owned.length >= CONTEXT_ITEMS_PER_USER_MAX) throw new ConvexError('CONTEXT_ITEM_LIMIT');
    }
    const changed = !prior || prior.contentHash !== contentHash;
    const row = {
      userId: args.userId, kind, key, title, summary, searchText, version, contentHash,
      tainted: args.tainted, ...(args.taintSource === undefined ? {} : {taintSource: args.taintSource}),
      ...(args.chatId === undefined ? {} : {chatId: args.chatId}), enabled: prior?.enabled ?? true,
      status: changed ? 'pending' as const : prior.status, attempts: changed ? 0 : prior.attempts,
      ...(changed ? {} : prior.model === undefined ? {} : {model: prior.model}),
      ...(changed ? {} : prior.dimensions === undefined ? {} : {dimensions: prior.dimensions}),
    };
    const id = prior ? prior._id : await ctx.db.insert('contextItems', row);
    if (prior) await ctx.db.replace(id, row);
    if (changed || row.status === 'pending') await ctx.scheduler.runAfter(0, internal.context.embed.embedPending, {userId: args.userId});
    return id;
  },
});

export const removeItem = internalMutation({
  args: {userId: v.string(), kind: v.string(), key: v.string()},
  handler: async (ctx, args) => {
    const row = await ctx.db.query('contextItems').withIndex('owner_kind_key', q => q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key)).unique();
    if (!row) return;
    const vectors = await ctx.db.query('contextVectors').withIndex('by_item', q => q.eq('itemId', row._id)).collect();
    for (const vector of vectors) await ctx.db.delete(vector._id);
    await ctx.db.delete(row._id);
  },
});

export const setEnabled = internalMutation({
  args: {userId: v.string(), kind: v.string(), key: v.string(), enabled: v.boolean()},
  handler: async (ctx, args) => {
    const row = await ctx.db.query('contextItems').withIndex('owner_kind_key', q => q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key)).unique();
    if (row) await ctx.db.patch(row._id, {enabled: args.enabled});
  },
});

export const pending = internalQuery({
  args: {userId: v.string()},
  handler: async (ctx, {userId}) => {
    const own = await ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', userId).eq('status', 'pending')).take(32);
    if (userId === CONTEXT_SHARED_OWNER) return own;
    const shared = await ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', CONTEXT_SHARED_OWNER).eq('status', 'pending')).take(32 - own.length);
    return [...own, ...shared];
  },
});

export const modelKey = internalQuery({
  args: {userId: v.string()},
  handler: async (ctx, {userId}) => {
    const row = await ctx.db.query('records').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', 'modelKey').eq('id', 'current')).unique();
    if (!row || row.deleted) return null;
    try {
      const value: unknown = JSON.parse(row.valueJson);
      if (typeof value !== 'object' || value === null || !('sealed' in value) || typeof value.sealed !== 'string') return null;
      return value.sealed;
    } catch {
      return null;
    }
  },
});
