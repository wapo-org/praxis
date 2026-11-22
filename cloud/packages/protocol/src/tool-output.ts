import {z} from 'zod';

/** Every Convex row writer stays below this, leaving room under the 1 MiB document limit for the row's own fields. */
export const DOCUMENT_BYTES_MAX = 900_000;
/** One offloaded tool-output chunk; a default 20k-character page reads at most two. */
export const TOOL_OUTPUT_CHUNK_CHARACTERS_MAX = 32_000;
/** Offloaded text beyond this is cut, so one spill stays within a single action's memory and a few mutations. */
export const TOOL_OUTPUT_CHARACTERS_MAX = 4_000_000;
/** Chunks one spill mutation writes; 32 x 32k characters stays far below the 16 MiB per-transaction write limit. */
export const TOOL_OUTPUT_CHUNKS_PER_WRITE_MAX = 32;

/** One page of an offloaded tool output, as the `read_tool_output` reader returns it. */
export const ToolOutputPageSchema = z.object({
  page: z.string(),
  characters: z.number().int().nonnegative(),
}).strict();
export type ToolOutputPage = z.infer<typeof ToolOutputPageSchema>;

/** UTF-8 size of a value's JSON form: what one stored row costs in Convex document bytes and Database I/O. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** `ConvexError` code a writer throws for a row over DOCUMENT_BYTES_MAX; the caller offloads first instead. */
export const DOCUMENT_TOO_LARGE = 'document_too_large';
