import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/** One generic owner-scoped row. `parentId` is an optional secondary index (e.g. a message's chatId). */
const row = {
  userId: v.string(),
  kind: v.string(),
  id: v.string(),
  parentId: v.optional(v.string()),
  value: v.any(),
  revision: v.number(),
  updatedAt: v.string(),
  deleted: v.boolean(),
};

export default defineSchema({
  toolSkillFiles: defineTable({userId:v.string(),skillId:v.string(),path:v.string(),content:v.string()})
    .index('owner_skill', ['userId','skillId']),
  toolState: defineTable({userId:v.string(),kind:v.string(),id:v.string(),value:v.any()})
    .index('owner_kind_id', ['userId','kind','id']),
  // Current state of every record, including tombstones.
  records: defineTable(row)
    .index('owner_kind_id', ['userId', 'kind', 'id'])
    .index('owner_kind_parent', ['userId', 'kind', 'parentId']),
  // Immutable revision log; the sync cursor is a per-owner revision, never wall-clock time.
  changes: defineTable(row).index('owner_revision', ['userId', 'revision']),
  // Per-owner monotonic revision counter.
  sequences: defineTable({ userId: v.string(), value: v.number() }).index('owner', ['userId']),
  // Better Auth models (user, session, account, verification, rateLimit) behind the server credential.
  authDocuments: defineTable({ model: v.string(), id: v.string(), data: v.any() })
    .index('model', ['model'])
    .index('model_id', ['model', 'id'])
    .index('model_email', ['model', 'data.email'])
    .index('model_token', ['model', 'data.token'])
    .index('model_user', ['model', 'data.userId'])
    .index('model_identifier', ['model', 'data.identifier'])
    .index('model_value', ['model','data.value']),
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
