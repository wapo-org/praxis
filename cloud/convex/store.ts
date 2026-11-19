import { ConvexError, v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './functions.js';
import {requireActiveOwner} from './ownerFunctions.js';
import { bounded, requireServer } from './access.js';
import {deleteDomainRow, domainDocument, domainRow, isDomainKind, listDomainRows, saveDomainRow} from './domainRecords.js';
import {activeOwner} from './accountOwner.js';

/** Owner-scoped Store requiring serverToken and userId. */
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

function genericRecord(ctx: QueryCtx, userId: string, kind: string, id: string) {
  return ctx.db
    .query('records')
    .withIndex('owner_kind_id', (q) => q.eq('userId', userId).eq('kind', kind).eq('id', id))
    .unique();
}

async function current(ctx: QueryCtx, userId: string, kind: string, id: string): Promise<Row | null> {
  if (!isDomainKind(kind)) return genericRecord(ctx, userId, kind, id);
  const doc = await domainDocument(ctx, userId, kind, id);
  if (doc) return domainRow(kind, doc);
  const last = await ctx.db.query('changes').withIndex('owner_kind_id_revision', q =>
    q.eq('userId', userId).eq('kind', kind).eq('id', id)).order('desc').first();
  return last?.deleted ? last : null;
}

export const get = query({
  args: address,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    if (isDomainKind(a.kind) && !await activeOwner(ctx, a.userId)) return null;
    return publicRow(await current(ctx, a.userId, a.kind, a.id));
  },
});

export const list = query({
  args: { ...scope, kind: v.string(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    bounded(a.kind);
    const parentId = a.parentId === undefined ? undefined : bounded(a.parentId);
    if (isDomainKind(a.kind)) {
      if (!await activeOwner(ctx, a.userId)) return [];
      return listDomainRows(ctx, a.userId, a.kind, parentId);
    }
    const rows =
      parentId === undefined
        ? await ctx.db
            .query('records')
            .withIndex('owner_kind_id', (q) => q.eq('userId', a.userId).eq('kind', a.kind))
            .collect()
        : await ctx.db
            .query('records')
            .withIndex('owner_kind_parent', (q) =>
              q.eq('userId', a.userId).eq('kind', a.kind).eq('parentId', parentId),
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
    const ownerIsActive = await activeOwner(ctx, a.userId);
    const rows = await ctx.db
      .query('changes')
      .withIndex('owner_revision', (q) => q.eq('userId', a.userId).gt('revision', a.after))
      .take(a.limit + 1);
    const page = rows.slice(0, a.limit);
    const records = page.filter(row => ownerIsActive || !isDomainKind(row.kind)).map(publicRow);
    return {
      records,
      cursor: page.at(-1)?.revision ?? a.after,
      hasMore: rows.length > a.limit,
    };
  },
});

/** Paginated owners with stored rows for maintenance scripts. */
export const owners = query({
  args: { serverToken: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const page = await ctx.db.query('sequences').paginate({ cursor: a.cursor, numItems: 200 });
    return { owners: page.page.map((row) => row.userId), cursor: page.isDone ? null : page.continueCursor };
  },
});

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

export async function writeRecord(ctx: MutationCtx, a: WriteInput) {
  [a.userId, a.kind, a.id].forEach(bounded);
  if (a.parentId !== undefined) bounded(a.parentId);
  if (a.value === null || typeof a.value !== 'object' || Array.isArray(a.value)) {
    throw new ConvexError('Expected JSON object');
  }
  if (isDomainKind(a.kind)) await requireActiveOwner(ctx, a.userId);
  // Sync records carry JSON values across the API boundary.
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
  const parentId = a.parentId ?? old?.parentId;
  const row = {
    userId: a.userId,
    kind: a.kind,
    id: a.id,
    ...(parentId === undefined ? {} : {parentId}),
    value: JSON.parse(json) as unknown,
    revision,
    updatedAt: new Date().toISOString(),
    deleted: a.deleted,
  };
  if (isDomainKind(a.kind)) {
    if (a.deleted) {
      const doc = await domainDocument(ctx, a.userId, a.kind, a.id);
      if (doc) await deleteDomainRow(ctx, doc, row.updatedAt);
    } else {
      Object.assign(row, await saveDomainRow(ctx, a.kind, row));
    }
  } else {
    const doc = await genericRecord(ctx, a.userId, a.kind, a.id);
    if (doc) await ctx.db.replace(doc._id, row);
    else await ctx.db.insert('records', row);
  }
  await ctx.db.insert('changes', row);
  return publicRow(row)!;
}

export const put = mutation({
  args: { ...address, value: v.any(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    return writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: a.value, deleted: false });
  },
});

export const remove = mutation({
  args: address,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    await writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, value: {}, deleted: true });
    return null;
  },
});

/** CAS write against expectedRevision (0 = absent) for at-least-once checkpoints. */
export const putIfRevision = mutation({
  args: { ...address, value: v.any(), parentId: v.optional(v.string()), expectedRevision: v.number() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    if (isDomainKind(a.kind)) await requireActiveOwner(ctx, a.userId);
    const old = await current(ctx, a.userId, a.kind, a.id);
    if ((old?.revision ?? 0) !== a.expectedRevision) return null;
    return writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: a.value, deleted: false });
  },
});
