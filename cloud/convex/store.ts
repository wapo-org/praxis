import { ConvexError, v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './functions.js';
import { bounded, requireServer } from './access.js';

/**
 * Generic owner-scoped Store behind the server credential.
 * Every function requires `serverToken` and an owner `userId`; rows are addressed by (userId, kind, id).
 */
const scope = { serverToken: v.string(), userId: v.string() };
const address = { ...scope, kind: v.string(), id: v.string() };

interface Row {
  userId: string;
  kind: string;
  id: string;
  parentId?: string;
  value: unknown;
  revision: number;
  updatedAt: string;
  deleted: boolean;
}

/** Strips Convex system fields; public IDs stay distinct from Convex document IDs. */
function publicRow(r: Row | null) {
  if (!r) return null;
  return {
    userId: r.userId,
    kind: r.kind,
    id: r.id,
    ...(r.parentId === undefined ? {} : { parentId: r.parentId }),
    value: r.value,
    revision: r.revision,
    updatedAt: r.updatedAt,
    deleted: r.deleted,
  };
}

function current(ctx: QueryCtx, userId: string, kind: string, id: string) {
  return ctx.db
    .query('records')
    .withIndex('owner_kind_id', (q) => q.eq('userId', userId).eq('kind', kind).eq('id', id))
    .unique();
}

export const get = query({
  args: address,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    return publicRow(await current(ctx, a.userId, a.kind, a.id));
  },
});

export const list = query({
  args: { ...scope, kind: v.string(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    bounded(a.kind);
    const parentId = a.parentId;
    const rows =
      parentId === undefined
        ? await ctx.db
            .query('records')
            .withIndex('owner_kind_id', (q) => q.eq('userId', a.userId).eq('kind', a.kind))
            .collect()
        : await ctx.db
            .query('records')
            .withIndex('owner_kind_parent', (q) =>
              q.eq('userId', a.userId).eq('kind', a.kind).eq('parentId', bounded(parentId)),
            )
            .collect();
    return rows.filter((r) => !r.deleted).map(publicRow);
  },
});

export const changes = query({
  args: { ...scope, after: v.number(), limit: v.number() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    if (!Number.isSafeInteger(a.after) || a.after < 0 || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > 1000) {
      throw new ConvexError('Invalid pagination');
    }
    const rows = await ctx.db
      .query('changes')
      .withIndex('owner_revision', (q) => q.eq('userId', a.userId).gt('revision', a.after))
      .take(a.limit + 1);
    const records = rows.slice(0, a.limit).map(publicRow);
    return {
      records,
      cursor: records.at(-1)?.revision ?? a.after,
      hasMore: rows.length > a.limit,
    };
  },
});

/** Latest revision for the owner (0 when none): newest entry of the owner's revision index. */
export const head = query({
  args: scope,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const latest = await ctx.db
      .query('changes')
      .withIndex('owner_revision', (q) => q.eq('userId', a.userId))
      .order('desc')
      .first();
    return latest?.revision ?? 0;
  },
});

interface WriteInput {
  userId: string;
  kind: string;
  id: string;
  parentId?: string;
  value: unknown;
  deleted: boolean;
}

/** Writes the current row and appends an immutable revision with the next per-owner sequence. */
async function write(ctx: MutationCtx, a: WriteInput) {
  [a.userId, a.kind, a.id].forEach(bounded);
  if (a.parentId !== undefined) bounded(a.parentId);
  if (a.value === null || typeof a.value !== 'object' || Array.isArray(a.value)) {
    throw new ConvexError('Expected JSON object');
  }
  // The JSON roundtrip rejects Convex-only values at this server boundary.
  const json = JSON.stringify(a.value);
  if (json.length > 900_000) throw new ConvexError('Record too large');

  const seq = await ctx.db
    .query('sequences')
    .withIndex('owner', (q) => q.eq('userId', a.userId))
    .unique();
  const revision = (seq?.value ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new ConvexError('Revision exhausted');
  if (seq) await ctx.db.patch(seq._id, { value: revision });
  else await ctx.db.insert('sequences', { userId: a.userId, value: revision });

  const old = await current(ctx, a.userId, a.kind, a.id);
  // A put without parentId keeps the existing one; tombstones keep it too.
  const parentId = a.parentId ?? old?.parentId;
  const row = {
    userId: a.userId,
    kind: a.kind,
    id: a.id,
    ...(parentId === undefined ? {} : { parentId }),
    value: JSON.parse(json),
    revision,
    updatedAt: new Date().toISOString(),
    deleted: a.deleted,
  };
  if (old) await ctx.db.replace(old._id, row);
  else await ctx.db.insert('records', row);
  await ctx.db.insert('changes', row);
  return publicRow(row)!;
}

export const put = mutation({
  args: { ...address, value: v.any(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    return write(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: a.value, deleted: false });
  },
});

export const remove = mutation({
  args: address,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    await write(ctx, { userId: a.userId, kind: a.kind, id: a.id, value: {}, deleted: true });
    return null;
  },
});

/**
 * Compare-and-set write: succeeds only when the current revision equals `expectedRevision`
 * (0 = the row must not exist). Used for checkpoint versions under at-least-once delivery.
 */
export const putIfRevision = mutation({
  args: { ...address, value: v.any(), parentId: v.optional(v.string()), expectedRevision: v.number() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const old = await current(ctx, a.userId, a.kind, a.id);
    if ((old?.revision ?? 0) !== a.expectedRevision) return null;
    return write(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: a.value, deleted: false });
  },
});
