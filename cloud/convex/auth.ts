import { ConvexError, v } from 'convex/values';
import { z } from 'zod';
import { mutation, query, type MutationCtx, type QueryCtx } from './functions.js';
import { requireServer } from './access.js';

/**
 * Better Auth database behind the server credential. The API's custom adapter
 * (apps/api/src/adapters/auth.ts) forwards each adapter operation here.
 */
const Where = z.object({
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  operator: z
    .enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'contains', 'starts_with', 'ends_with'])
    .default('eq'),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number()), z.null()]),
  connector: z.enum(['AND', 'OR']).default('AND'),
  mode: z.enum(['sensitive', 'insensitive']).default('sensitive'),
});

const Input = z.object({
  model: z.enum(['user', 'session', 'account', 'verification', 'rateLimit']),
  where: z.array(Where).max(30).default([]),
  data: z.record(z.string(), z.json()).optional(),
  update: z.record(z.string(), z.json()).optional(),
  select: z.array(z.string()).optional(),
  limit: z.number().int().min(0).max(10_000).default(100),
  offset: z.number().int().nonnegative().default(0),
  sortBy: z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }).optional(),
  join: z.unknown().optional(),
  increment: z.record(z.string(), z.number()).optional(),
  set: z.record(z.string(), z.json()).optional(),
});
type Input = z.infer<typeof Input>;
type Clause = Input['where'][number];
type Data = Record<string, unknown>;

const lower = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : x);

function evalClause(data: Data, w: Clause): boolean {
  let a: unknown = data[w.field] ?? null;
  let b: unknown = w.value;
  if (w.mode === 'insensitive') {
    a = lower(a);
    b = Array.isArray(b) ? b.map(lower) : lower(b);
  }
  const cmp = (fn: (x: never, y: never) => boolean) => b !== null && a !== null && fn(a as never, b as never);
  switch (w.operator) {
    case 'eq':
      return b === null ? a === null : a === b;
    case 'ne':
      return a !== b;
    case 'lt':
      return cmp((x, y) => x < y);
    case 'lte':
      return cmp((x, y) => x <= y);
    case 'gt':
      return cmp((x, y) => x > y);
    case 'gte':
      return cmp((x, y) => x >= y);
    case 'in':
      return Array.isArray(b) && b.includes(a as never);
    case 'not_in':
      return Array.isArray(b) && !b.includes(a as never);
    case 'contains':
      return typeof a === 'string' && a.includes(String(b));
    case 'starts_with':
      return typeof a === 'string' && a.startsWith(String(b));
    case 'ends_with':
      return typeof a === 'string' && a.endsWith(String(b));
  }
}

/** Same left-to-right AND/OR fold as Better Auth's reference memory adapter. */
function matches(data: Data, where: Clause[]): boolean {
  if (where.length === 0) return true;
  let result = evalClause(data, where[0]!);
  for (const clause of where) {
    const value = evalClause(data, clause);
    result = clause.connector === 'OR' ? result || value : result && value;
  }
  return result;
}

const INDEX_BY_FIELD = {
  id: 'model_id',
  email: 'model_email',
  token: 'model_token',
  userId: 'model_user',
  identifier: 'model_identifier',
} as const;

async function rows(ctx: QueryCtx, input: Input) {
  if (input.join && Object.keys(input.join as object).length) throw new ConvexError('Auth joins are disabled');
  // With only AND connectors the fold is a conjunction, so one equality clause can drive an index.
  const allAnd = input.where.every((w) => w.connector !== 'OR');
  const indexed = allAnd
    ? input.where.find(
        (w) => w.operator === 'eq' && w.mode !== 'insensitive' && typeof w.value === 'string' && w.field in INDEX_BY_FIELD,
      )
    : undefined;
  let result;
  if (indexed) {
    const field = indexed.field as keyof typeof INDEX_BY_FIELD;
    const value = indexed.value as string;
    result = await ctx.db
      .query('authDocuments')
      .withIndex(INDEX_BY_FIELD[field], (q) =>
        // Index field paths are typed per index; the value is validated above.
        (q.eq('model', input.model) as any).eq(field === 'id' ? 'id' : `data.${field}`, value),
      )
      .collect();
  } else {
    result = await ctx.db
      .query('authDocuments')
      .withIndex('model', (q) => q.eq('model', input.model))
      .collect();
  }
  result = result.filter((r) => matches(r.data, input.where));
  if (input.sortBy) {
    const { field, direction } = input.sortBy;
    result.sort((a, b) => {
      const x = a.data[field];
      const y = b.data[field];
      return (x === y ? 0 : x < y ? -1 : 1) * (direction === 'asc' ? 1 : -1);
    });
  }
  return result;
}

function select(data: Data, fields?: string[]) {
  if (!fields) return data;
  return Object.fromEntries(fields.filter((f) => Object.hasOwn(data, f)).map((f) => [f, data[f]]));
}

async function assertUnique(ctx: MutationCtx, model: Input['model'], data: Data) {
  const byIndex = async (field: keyof typeof INDEX_BY_FIELD, value: unknown) =>
    typeof value === 'string'
      ? (await rows(ctx, Input.parse({ model, where: [{ field, value }], limit: 1 }))).length > 0
      : false;
  const clash =
    (await byIndex('id', data.id)) ||
    (model === 'user' && (await byIndex('email', data.email))) ||
    (model === 'session' && (await byIndex('token', data.token))) ||
    (model === 'account' &&
      typeof data.userId === 'string' &&
      (await rows(ctx, Input.parse({ model, where: [{ field: 'userId', value: data.userId }] }))).some(
        (r) => r.data.providerId === data.providerId && r.data.accountId === data.accountId,
      ));
  if (clash) throw new ConvexError('Auth unique constraint');
}

const args = { serverToken: v.string(), operation: v.string(), input: v.any() };

export const read = query({
  args,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const input = Input.parse(a.input);
    const all = await rows(ctx, input);
    switch (a.operation) {
      case 'count':
        return all.length;
      case 'findOne':
        return all[0] ? select(all[0].data, input.select) : null;
      case 'findMany':
        return all.slice(input.offset, input.offset + input.limit).map((r) => select(r.data, input.select));
      default:
        throw new ConvexError('Unknown auth read');
    }
  },
});

export const execute = mutation({
  args,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const input = Input.parse(a.input);

    if (a.operation === 'create') {
      const data = input.data;
      if (!data || typeof data.id !== 'string' || !data.id) throw new ConvexError('Auth ID required');
      if((input.model==='session'||input.model==='account')&&typeof data.userId==='string'){
        const owner=await ctx.db.query('authDocuments').withIndex('model_id',q=>q.eq('model','user').eq('id',data.userId as string)).unique();
        if(!owner||owner.data.deleting)throw new ConvexError('Account unavailable');
      }
      await assertUnique(ctx, input.model, data);
      await ctx.db.insert('authDocuments', { model: input.model, id: data.id, data });
      return select(data, input.select);
    }

    const all = await rows(ctx, input);
    const many = a.operation === 'updateMany' || a.operation === 'deleteMany';
    const selected = many ? all : all.slice(0, 1);

    if (a.operation === 'delete' || a.operation === 'deleteMany' || a.operation === 'consumeOne') {
      for (const r of selected) await ctx.db.delete(r._id);
      if (a.operation === 'consumeOne') return selected[0]?.data ?? null;
      return a.operation === 'deleteMany' ? selected.length : null;
    }

    if (a.operation === 'update' || a.operation === 'updateMany' || a.operation === 'incrementOne') {
      for (const r of selected) {
        const data: Data = { ...r.data, ...input.update, ...input.set };
        if (data.id !== r.id) throw new ConvexError('Immutable auth ID');
        for (const [field, n] of Object.entries(input.increment ?? {})) {
          if (typeof data[field] !== 'number') throw new ConvexError('Invalid counter');
          data[field] = (data[field] as number) + n;
        }
        await ctx.db.patch(r._id, { data });
        r.data = data;
      }
      return many ? selected.length : (selected[0]?.data ?? null);
    }

    throw new ConvexError('Unknown auth mutation');
  },
});
