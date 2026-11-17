import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export default defineSchema({
  emails: defineTable({ text: v.optional(v.string()) }),
});
