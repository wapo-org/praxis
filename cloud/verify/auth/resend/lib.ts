import { mutationGeneric, queryGeneric } from 'convex/server';
import { v } from 'convex/values';
export const sendEmail = mutationGeneric({
  args: {
    options: v.object({ apiKey: v.string(), testMode: v.boolean(), initialBackoffMs: v.number(), retryAttempts: v.number() }),
    from: v.string(), to: v.array(v.string()), subject: v.optional(v.string()),
    html: v.optional(v.string()), text: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => ctx.db.insert('emails', { text: args.text }),
});
export const latest = queryGeneric({
  args: {},
  handler: async ctx => (await ctx.db.query('emails').order('desc').first())?.text ?? null,
});
