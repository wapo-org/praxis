import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const webhookStatus = v.union(v.literal('connected'), v.literal('failed'));

export const connections = defineTable({
  userId: v.string(),
  toolkit: v.string(),
  status: v.union(v.literal('pending'), webhookStatus),
  connectedAccountId: v.string(),
  redirectUrl: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_user_toolkit', ['userId', 'toolkit'])
  .index('by_connected_account', ['connectedAccountId'])
  .index('by_status_expires', ['status', 'expiresAt']);
