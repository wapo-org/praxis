import {ConvexError, v} from 'convex/values';
import {TOOL_OUTPUT_CHARACTERS_MAX, TOOL_OUTPUT_CHUNK_CHARACTERS_MAX, TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX, ToolOutputPageSchema, type Message, type ToolOutputPage} from '@praxis/protocol';
import {assertActiveOwner, internalMutation, internalQuery, type MutationCtx, type QueryCtx} from './functions.js';
import {internal} from './_generated/api.js';
import {requireLiveTurn} from './agent/ledger.js';
import {runScope} from './workflows/validators.js';
import {assertDocumentFits} from './sizeGuard.js';
import {OUTPUT_ERRORS, OUTPUT_ORPHAN_AGE_MS, OUTPUT_SWEEP_CHUNKS_MAX, OUTPUT_SWEEP_MANIFESTS_MAX} from './outputConstants.js';

const turnArgs = {...runScope, expectedTurnIndex: v.number()};

export function chunkId(ref: string, index: number): string {
  return `${ref}:${index}`;
}

function manifest(ctx: QueryCtx, userId: string, id: string) {
  return ctx.db.query('toolOutputs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
}

function chunk(ctx: QueryCtx, userId: string, ref: string, index: number) {
  return ctx.db.query('outputs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', chunkId(ref, index))).unique();
}

/** Opens an uncommitted manifest under the live turn; chunks follow in `writeChunks`. */
export const begin = internalMutation({
  args: {...turnArgs, ref: v.string(), callId: v.string(), characters: v.number(), chunks: v.number()},
  handler: async (ctx, {ref, callId, characters, chunks, ...scope}) => {
    await assertActiveOwner(ctx, scope.userId);
    await requireLiveTurn(ctx, scope);
    if (characters > TOOL_OUTPUT_CHARACTERS_MAX || chunks !== Math.ceil(characters / TOOL_OUTPUT_CHUNK_CHARACTERS_MAX)) {
      throw new ConvexError(OUTPUT_ERRORS.chunk);
    }
    if (await manifest(ctx, scope.userId, ref)) throw new ConvexError(OUTPUT_ERRORS.exists);
    await ctx.db.insert('toolOutputs', {
      userId: scope.userId, id: ref, chatId: scope.chatId, runId: scope.runId, callId,
      characters, chunks, committed: false, createdAt: Date.now(),
    });
  },
});

export const writeChunks = internalMutation({
  args: {userId: v.string(), ref: v.string(), from: v.number(), texts: v.array(v.string())},
  handler: async (ctx, {userId, ref, from, texts}) => {
    await assertActiveOwner(ctx, userId);
    const owner = await manifest(ctx, userId, ref);
    if (!owner || owner.committed || texts.length > TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX || from + texts.length > owner.chunks) {
      throw new ConvexError(OUTPUT_ERRORS.chunk);
    }
    const updatedAt = new Date().toISOString();
    for (const [offset, text] of texts.entries()) {
      const index = from + offset;
      const last = index === owner.chunks - 1;
      // Fixed-size chunks let the reader find an offset's chunk without reading the others.
      if (last ? text.length > TOOL_OUTPUT_CHUNK_CHARACTERS_MAX : text.length !== TOOL_OUTPUT_CHUNK_CHARACTERS_MAX) {
        throw new ConvexError(OUTPUT_ERRORS.chunk);
      }
      const row = {userId, id: chunkId(ref, index), revision: 0, updatedAt, chatId: owner.chatId, parentId: ref, text};
      assertDocumentFits('outputChunk', row);
      if (await chunk(ctx, userId, ref, index)) throw new ConvexError(OUTPUT_ERRORS.chunk);
      await ctx.db.insert('outputs', row);
    }
  },
});

/** One page of an offloaded output in `chatId`; null when it is gone, partial, or from another chat. */
export async function readOutputPage(
  ctx: QueryCtx, input: {userId: string; chatId: string; id: string; offset: number; limit: number},
): Promise<ToolOutputPage | null> {
  const owner = await manifest(ctx, input.userId, input.id);
  if (!owner || owner.chatId !== input.chatId) return null;
  const end = Math.min(owner.characters, input.offset + input.limit);
  const size = TOOL_OUTPUT_CHUNK_CHARACTERS_MAX;
  const texts: string[] = [];
  for (let index = Math.floor(input.offset / size); index * size < end; index++) {
    const row = await chunk(ctx, input.userId, input.id, index);
    if (!row) return null;
    texts.push(row.text.slice(Math.max(0, input.offset - index * size), end - index * size));
  }
  return ToolOutputPageSchema.parse({page: texts.join(''), characters: owner.characters});
}

export const read = internalQuery({
  args: {userId: v.string(), chatId: v.string(), id: v.string(), offset: v.number(), limit: v.number()},
  handler: async (ctx, input): Promise<ToolOutputPage | null> => readOutputPage(ctx, input),
});

/** Inside the turn commit: every output its messages reference is kept by the sweep from now on. */
export async function markOutputsCommitted(ctx: MutationCtx, userId: string, chatId: string, messages: readonly Message[]) {
  const refs = new Set(messages.flatMap(message => message.parts.flatMap(part => part.outputRef ? [part.outputRef] : [])));
  for (const ref of refs) {
    const row = await manifest(ctx, userId, ref);
    // A missing output is not fatal: the reader answers "no longer available" instead of failing every retry.
    if (row && row.chatId === chatId && !row.committed) await ctx.db.patch(row._id, {committed: true});
  }
}

/** Deletes outputs no committed message references once they are a day old; bounded, and continues itself. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - OUTPUT_ORPHAN_AGE_MS;
    const orphans = await ctx.db.query('toolOutputs')
      .withIndex('by_committed_created', q => q.eq('committed', false).lt('createdAt', cutoff))
      .take(OUTPUT_SWEEP_MANIFESTS_MAX);
    let budget = OUTPUT_SWEEP_CHUNKS_MAX;
    for (const orphan of orphans) {
      const chunks = await ctx.db.query('outputs')
        .withIndex('by_user_output', q => q.eq('userId', orphan.userId).eq('parentId', orphan.id))
        .take(budget + 1);
      for (const row of chunks.slice(0, budget)) await ctx.db.delete(row._id);
      if (chunks.length > budget) {
        await ctx.scheduler.runAfter(0, internal.outputs.sweep, {});
        return OUTPUT_SWEEP_CHUNKS_MAX;
      }
      budget -= chunks.length;
      await ctx.db.delete(orphan._id);
    }
    if (orphans.length === OUTPUT_SWEEP_MANIFESTS_MAX) await ctx.scheduler.runAfter(0, internal.outputs.sweep, {});
    return OUTPUT_SWEEP_CHUNKS_MAX - budget;
  },
});
