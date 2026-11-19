import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {domainTables} from './domainSchema.js';

/** Generic owner-scoped row with optional parentId index. */
const row = {
  userId: v.string(),
  kind: v.string(),
  id: v.string(),
  parentId: v.optional(v.string()),
  valueJson: v.string(),
  revision: v.number(),
  updatedAt: v.string(),
  deleted: v.boolean(),
};

export default defineSchema({
  // `deleting` fences every owner write once account deletion begins.
  users: defineTable({
    deleting: v.optional(v.boolean()),
    deletionSessionId: v.optional(v.string()),
    deletion: v.optional(v.union(v.object({ blobCursor: v.string() }), v.object({ blobsDone: v.literal(true) }))),
  }),
  oauthEmails: defineTable({ userId: v.id('users'), email: v.string() })
    .index('email', ['email'])
    .index('user', ['userId']),
  ...domainTables,
  toolSkillFiles: defineTable({userId:v.string(),skillId:v.string(),path:v.string(),content:v.string()})
    .index('owner_skill', ['userId','skillId']),
  toolState: defineTable({
    userId: v.string(),
    kind: v.string(),
    id: v.string(),
    value: v.union(
      v.object({encoded: v.string()}),
      v.object({allowanceMicroUsd: v.number()}),
      v.object({period: v.string(), state: v.union(v.literal('reserved'), v.literal('closed'))}),
      v.object({payer: v.literal('platform'), service: v.string(), slot: v.number(), actualMicroUsd: v.number(), period: v.string()}),
    ),
  })
    .index('owner_kind_id', ['userId','kind','id']),
  records: defineTable(row)
    .index('owner_kind_id', ['userId', 'kind', 'id'])
    .index('owner_kind_parent', ['userId', 'kind', 'parentId']),
  // Immutable revision log keyed by per-owner sequence, never wall-clock.
  changes: defineTable(row)
    .index('owner_revision', ['userId', 'revision'])
    .index('owner_kind_id_revision', ['userId', 'kind', 'id', 'revision']),
  sequences: defineTable({ userId: v.string(), value: v.number() }).index('owner', ['userId']),
  // Semantic search: one vector per chat title or message chunk (convex/search.ts). `scope` = owner + embedder.
  embeddings: defineTable({
    userId: v.string(),
    scope: v.string(),
    itemId: v.string(),
    chatId: v.string(),
    text: v.string(),
    vector: v.array(v.float64()),
  })
    .index('owner', ['userId'])
    .index('scope_item', ['scope', 'itemId'])
    .vectorIndex('by_vector', { vectorField: 'vector', dimensions: 384, filterFields: ['scope'] }),
  // Owner-bound Convex file storage (attachments). A ticket is created before bytes arrive.
  files: defineTable({
    userId: v.string(),
    ticket: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    chatId: v.optional(v.string()),
    expiresAt: v.number(),
    storageId: v.optional(v.id('_storage')),
    sha256: v.optional(v.string()),
    status: v.union(v.literal('pending'), v.literal('uploading'), v.literal('uploaded'), v.literal('ready')),
  })
    .index('ticket', ['ticket'])
    .index('owner_ticket', ['userId', 'ticket'])
    .index('owner_status', ['userId', 'status'])
    .index('storage', ['storageId'])
    .index('owner_storage', ['userId', 'storageId'])
    .index('status_expires', ['status', 'expiresAt']),
});
