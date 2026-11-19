import {JsonObjectSchema, type JsonObject} from '@praxis/protocol';
import type {Doc} from './_generated/dataModel.js';
import { ConvexError, v } from 'convex/values';
import { assertActiveOwner, query, serverMutation, serverQuery, type MutationCtx, type QueryCtx } from './functions.js';
import { bounded, requireServer } from './access.js';
import {deleteDomainRow, domainDocument, domainRow, isDomainKind, listDomainRows, saveDomainRow} from './domainRecords.js';
import {activeOwner} from './accountOwner.js';

/** Owner-scoped Store requiring serverToken and userId. */
const scope = { serverToken: v.string(), userId: v.string() };
const address = { ...scope, kind: v.string(), id: v.string() };
const RECORD_JSON_CHARACTERS_MAX = 900_000;

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

function decodeRow({valueJson, ...row}: Doc<'records'> | Doc<'changes'>): Row {
  return {...row, value: JsonObjectSchema.parse(JSON.parse(valueJson))};
}

function genericRecord(ctx: QueryCtx, userId: string, kind: string, id: string) {
  return ctx.db
    .query('records')
    .withIndex('owner_kind_id', (q) => q.eq('userId', userId).eq('kind', kind).eq('id', id))
    .unique();
}

async function current(ctx: QueryCtx, userId: string, kind: string, id: string): Promise<Row | null> {
  if (!isDomainKind(kind)) {
    const row = await genericRecord(ctx, userId, kind, id);
    return row && decodeRow(row);
  }
  const doc = await domainDocument(ctx, userId, kind, id);
  if (doc) return domainRow(kind, doc);
  const last = await ctx.db.query('changes').withIndex('owner_kind_id_revision', q =>
    q.eq('userId', userId).eq('kind', kind).eq('id', id)).order('desc').first();
  return last?.deleted ? decodeRow(last) : null;
}

export const get = serverQuery({
  args: address,
  handler: async (ctx, a) => {
    bounded(a.userId);
    if (isDomainKind(a.kind) && !await activeOwner(ctx, a.userId)) return null;
    return publicRow(await current(ctx, a.userId, a.kind, a.id));
  },
});

export const list = serverQuery({
  args: { ...scope, kind: v.string(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
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
    return rows.filter(r => !r.deleted).map(row => publicRow(decodeRow(row)));
  },
});

export const changes = serverQuery({
  args: { ...scope, after: v.number(), limit: v.number() },
  handler: async (ctx, a) => {
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
    const records = page.filter(row => ownerIsActive || !isDomainKind(row.kind)).map(row => publicRow(decodeRow(row)));
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

export const head = serverQuery({
  args: scope,
  handler: async (ctx, a) => {
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
  value: JsonObject;
  deleted: boolean;
}

export async function writeRecord(ctx: MutationCtx, a: WriteInput) {
  [a.userId, a.kind, a.id].forEach(bounded);
  if (a.parentId !== undefined) bounded(a.parentId);
  if (isDomainKind(a.kind)) await assertActiveOwner(ctx, a.userId);
  if (JSON.stringify(a.value).length > RECORD_JSON_CHARACTERS_MAX) throw new ConvexError('Record too large');

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
    value: a.value,
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
  }
  const {value, ...metadata} = row;
  const stored = {...metadata, valueJson: JSON.stringify(value)};
  if (!isDomainKind(a.kind)) {
    const doc = await genericRecord(ctx, a.userId, a.kind, a.id);
    if (doc) await ctx.db.replace(doc._id, stored);
    else await ctx.db.insert('records', stored);
  }
  await ctx.db.insert('changes', stored);
  return publicRow(row)!;
}

export const put = serverMutation({
  args: { ...address, valueJson: v.string(), parentId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    return writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: JsonObjectSchema.parse(JSON.parse(a.valueJson)), deleted: false });
  },
});

export const remove = serverMutation({
  args: address,
  handler: async (ctx, a) => {
    await writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, value: {}, deleted: true });
    return null;
  },
});

/** CAS write against expectedRevision (0 = absent) for at-least-once checkpoints. */
export const putIfRevision = serverMutation({
  args: { ...address, valueJson: v.string(), parentId: v.optional(v.string()), expectedRevision: v.number() },
  handler: async (ctx, a) => {
    bounded(a.userId);
    if (isDomainKind(a.kind)) await assertActiveOwner(ctx, a.userId);
    const old = await current(ctx, a.userId, a.kind, a.id);
    if ((old?.revision ?? 0) !== a.expectedRevision) return null;
    return writeRecord(ctx, { userId: a.userId, kind: a.kind, id: a.id, parentId: a.parentId, value: JsonObjectSchema.parse(JSON.parse(a.valueJson)), deleted: false });
  },
});
