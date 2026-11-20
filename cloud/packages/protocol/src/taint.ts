import {z} from 'zod';

export const TAINT_SOURCE_CHARACTERS_MAX = 200;
/** Display label for where untrusted content came from, recorded with the stored tool result. */
export const TaintSourceSchema = z.string().min(1).max(TAINT_SOURCE_CHARACTERS_MAX);
/** Present once a run has read untrusted content; it is never cleared while the run lives. */
export const RunTaintSchema = z.object({
  tainted: z.literal(true),
  source: TaintSourceSchema,
  callId: z.string().min(1),
}).strict();
export type RunTaint = z.infer<typeof RunTaintSchema>;
