import {defineTable} from 'convex/server';
import {v} from 'convex/values';
import {CONTEXT_EMBEDDING_DIMENSIONS} from './constants.js';

export const contextItems = defineTable({
  userId: v.string(),
  kind: v.string(),
  key: v.string(),
  title: v.string(),
  summary: v.string(),
  searchText: v.string(),
  version: v.string(),
  contentHash: v.string(),
  tainted: v.boolean(),
  taintSource: v.optional(v.string()),
  chatId: v.optional(v.string()),
  enabled: v.boolean(),
  status: v.union(v.literal('pending'), v.literal('ready'), v.literal('failed')),
  attempts: v.number(),
  model: v.optional(v.string()),
  dimensions: v.optional(v.number()),
})
  .index('owner_kind_key', ['userId', 'kind', 'key'])
  .index('owner_status', ['userId', 'status'])
  .searchIndex('by_text', {searchField: 'searchText', filterFields: ['userId', 'kind', 'enabled']});

export const contextVectors = defineTable({
  userId: v.string(),
  itemId: v.id('contextItems'),
  scopeKind: v.string(),
  kind: v.string(),
  model: v.string(),
  dimensions: v.number(),
  contentHash: v.string(),
  vector: v.array(v.float64()),
})
  .index('by_item', ['itemId'])
  .index('owner', ['userId'])
  .vectorIndex('by_vector', {vectorField: 'vector', dimensions: CONTEXT_EMBEDDING_DIMENSIONS, filterFields: ['scopeKind']});
