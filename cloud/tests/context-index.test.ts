import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema.js';
import {internal} from '../convex/_generated/api.js';

const modules = import.meta.glob('../convex/**/*.ts');
const USER_A = 'context-user-a';
const USER_B = 'context-user-b';

describe('context index', () => {
  beforeEach(() => vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', 'context-test-server-token-longer-than-32-characters'));
  afterEach(() => vi.unstubAllEnvs());

  it('deduplicates an owner key, bounds summaries, and removes associated vectors', async () => {
    const t = convexTest(schema, modules);
    const args = {userId: USER_A, kind: 'skill', key: 'search', title: 'Search', summary: 'x'.repeat(700), searchText: 'search', version: '1', tainted: false};
    const first = await t.mutation(internal.context.items.upsertItem, args);
    const second = await t.mutation(internal.context.items.upsertItem, {...args, title: 'Changed'});
    expect(first).toBe(second);
    await t.run(async ctx => {
      const [item] = await ctx.db.query('contextItems').collect();
      expect(item?.summary).toHaveLength(600);
      await ctx.db.insert('contextVectors', {
        userId: USER_A, itemId: first, scopeKind: 'scope', kind: 'skill', model: 'old', dimensions: 768,
        contentHash: item!.contentHash, vector: Array(768).fill(0),
      });
    });
    await t.mutation(internal.context.items.removeItem, {userId: USER_A, kind: 'skill', key: 'search'});
    const remaining = await t.run(async ctx => ({items: await ctx.db.query('contextItems').collect(), vectors: await ctx.db.query('contextVectors').collect()}));
    expect(remaining).toEqual({items: [], vectors: []});
  });

  it('keeps shared rows outside owner purge queries', async () => {
    const t = convexTest(schema, modules);
    const create = (userId: string, key: string) => t.mutation(internal.context.items.upsertItem, {
      userId, kind: 'tool', key, title: key, summary: key, searchText: key, version: '1', tainted: false,
    });
    await create(USER_A, 'a');
    await create(USER_B, 'b');
    await create('@shared', 'shared');
    const owned = await t.run(ctx => ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', USER_A)).collect());
    expect(owned.map(row => row.key)).toEqual(['a']);
  });

  it('rejects a new row over the owner cap while allowing updates', async () => {
    const t = convexTest(schema, modules);
    await t.run(async ctx => {
      for (let index = 0; index < 1_000; index++) {
        const key = `item-${index}`;
        await ctx.db.insert('contextItems', {
          userId: USER_A, kind: 'tool', key, title: key, summary: key, searchText: key, version: '1', contentHash: key,
          tainted: false, enabled: true, status: 'pending', attempts: 0,
        });
      }
    });
    await expect(t.mutation(internal.context.items.upsertItem, {
      userId: USER_A, kind: 'tool', key: 'new', title: 'New', summary: 'new', searchText: 'new', version: '1', tainted: false,
    })).rejects.toThrow('CONTEXT_ITEM_LIMIT');
    await expect(t.mutation(internal.context.items.upsertItem, {
      userId: USER_A, kind: 'tool', key: 'item-0', title: 'Updated', summary: 'updated', searchText: 'updated', version: '2', tainted: false,
    })).resolves.toBeDefined();
  });
});
