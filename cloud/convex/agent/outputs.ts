import {
  TOOL_OUTPUT_CHARACTERS_MAX, TOOL_OUTPUT_CHUNK_CHARACTERS_MAX, TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX, ToolOutputPageSchema,
} from '@praxis/protocol';
import {toolOutputReaderTool, type AgentTool, type ToolOutputReader} from '@praxis/agent/harness';
import {internal} from '../_generated/api.js';
import type {ActionCtx} from '../functions.js';
import type {TurnScope} from '../workflows/turnState.js';

/** Text beyond TOOL_OUTPUT_CHARACTERS_MAX is cut with a note, so the stored output says it is partial. */
function storedText(text: string): string {
  if (text.length <= TOOL_OUTPUT_CHARACTERS_MAX) return text;
  const note = `\n[Stored output ends here; the tool returned ${text.length} characters]`;
  return text.slice(0, TOOL_OUTPUT_CHARACTERS_MAX - note.length) + note;
}

function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += TOOL_OUTPUT_CHUNK_CHARACTERS_MAX) {
    chunks.push(text.slice(at, at + TOOL_OUTPUT_CHUNK_CHARACTERS_MAX));
  }
  return chunks;
}

/** The harness spill port: an uncommitted manifest, then fixed-size chunks; the turn commit marks it referenced. */
export function convexSpill(ctx: ActionCtx, scope: TurnScope) {
  return async (callId: string, text: string): Promise<string> => {
    const ref = crypto.randomUUID();
    const chunks = chunksOf(storedText(text));
    const characters = chunks.reduce((total, chunk) => total + chunk.length, 0);
    await ctx.runMutation(internal.outputs.begin, {...scope, ref, callId, characters, chunks: chunks.length});
    for (let from = 0; from < chunks.length; from += TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX) {
      const texts = chunks.slice(from, from + TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX);
      await ctx.runMutation(internal.outputs.writeChunks, {userId: scope.userId, ref, from, texts});
    }
    return ref;
  };
}

/** `read_tool_output` over this owner's offloaded outputs; the reader scopes every read to the caller's chat. */
export function convexOutputReaderTool(ctx: ActionCtx): AgentTool {
  const read: ToolOutputReader = async (context, id, offset, limit) => {
    const page = await ctx.runQuery(internal.outputs.read, {userId: context.userId, chatId: context.chatId, id, offset, limit});
    return page === null ? undefined : ToolOutputPageSchema.parse(page);
  };
  return toolOutputReaderTool(read);
}
