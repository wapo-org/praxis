import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { connections } from './composio/schema.js';
import {runStatus} from './workflows/validators.js';

/** Generic owner-scoped row with optional parentId index. */
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
  connections,
  // `deleting` fences every owner write once account deletion begins.
  users: defineTable({
    deleting: v.optional(v.boolean()),
    deletionSessionId: v.optional(v.string()),
    deletion: v.optional(v.union(v.object({ blobCursor: v.string() }), v.object({ blobsDone: v.literal(true) }))),
  }),
  oauthEmails: defineTable({ userId: v.id('users'), email: v.string() })
    .index('email', ['email'])
    .index('user', ['userId']),
  runs: defineTable({
    userId: v.string(), chatId: v.string(), status: runStatus,
    startTurnIndex: v.number(), nextTurnIndex: v.number(), generation: v.number(),
    workflowId: v.optional(v.string()),
  }).index('owner_chat', ['userId', 'chatId']),
  turnFlags: defineTable({
    runId: v.id('runs'), generation: v.number(), turnIndex: v.number(),
    done: v.boolean(), status: v.union(v.literal('ready'), v.literal('completed'), v.literal('stopped')),
  }).index('run_generation_turn', ['runId', 'generation', 'turnIndex']),
  toolSkillFiles: defineTable({userId:v.string(),skillId:v.string(),path:v.string(),content:v.string()})
    .index('owner_skill', ['userId','skillId']),
  toolState: defineTable({userId:v.string(),kind:v.string(),id:v.string(),value:v.any()})
    .index('owner_kind_id', ['userId','kind','id']),
  records: defineTable(row)
    .index('owner_kind_id', ['userId', 'kind', 'id'])
    .index('owner_kind_parent', ['userId', 'kind', 'parentId']),
  // Immutable revision log keyed by per-owner sequence, never wall-clock.
  changes: defineTable(row).index('owner_revision', ['userId', 'revision']),
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
