import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export default defineSchema({
  emails: defineTable({ to: v.array(v.string()), text: v.optional(v.string()) }),
});
