import {READ_TOOL_OUTPUT_TOOL_NAME, type ToolOutputPage} from '@praxis/protocol';
import {MAX_RESULT_CHARACTERS, textResult, type AgentTool, type ToolContext, type ToolResult} from './types.js';

/** Leaves room for the page header below MAX_RESULT_CHARACTERS. */
export const MAX_READ_CHARACTERS = MAX_RESULT_CHARACTERS - 200;
const DEFAULT_READ_CHARACTERS = 20_000;

/** Stores the full text of one oversized result and returns its `outputRef`. */
export type ToolOutputSpill = (text: string) => Promise<string>;
/** One page of an offloaded output in the caller's chat; `undefined` once it is gone or belongs elsewhere. */
export type ToolOutputReader = (
  context: ToolContext, id: string, offset: number, limit: number,
) => Promise<ToolOutputPage | undefined>;

/** The text a model sees for one result: text parts as-is, anything else as JSON. */
export function resultText(result: ToolResult): string {
  return result.content.map(item => typeof item.text === 'string' ? item.text : JSON.stringify(item)).join('\n');
}

/** Results over MAX_RESULT_CHARACTERS keep only their head inline; the full text is offloaded behind `outputRef`. */
export async function compactResult(result: ToolResult, spill: ToolOutputSpill | undefined): Promise<ToolResult> {
  const full = resultText(result);
  if (full.length <= MAX_RESULT_CHARACTERS) return result;
  const ref = spill ? await spill(full) : undefined;
  const note = ref ? `; ${READ_TOOL_OUTPUT_TOOL_NAME} ${ref}` : '';
  const content = [{type: 'text', text: `${full.slice(0, MAX_RESULT_CHARACTERS)}\n[Output truncated${note}]`}];
  return {...result, content, ...(ref ? {outputRef: ref} : {})};
}

/** Model-visible text for a reference whose output was swept or purged; a normal result, so the turn continues. */
export function outputUnavailableText(id: string): string {
  return `Output ${id} is no longer available. Run the original tool again if you still need it.`;
}

function integerArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Pages through offloaded tool results in this chat. */
export function toolOutputReaderTool(read: ToolOutputReader): AgentTool {
  return {
    spec: {
      type: 'tool.spec', name: READ_TOOL_OUTPUT_TOOL_NAME, source: {type: 'builtin'}, traits: ['readOnly', 'idempotent'],
      description: 'Read more of a tool result that was truncated. Pass the id from the truncation note and a character offset.',
      inputSchema: {type: 'object', properties: {
        id: {type: 'string', description: 'Id from the truncation note'},
        offset: {type: 'integer', description: 'Character offset to start at'},
        limit: {type: 'integer', description: `Characters to read (default ${DEFAULT_READ_CHARACTERS}, at most ${MAX_READ_CHARACTERS})`},
      }, required: ['id', 'offset']},
    },
    // Offloaded output is external tool data, so paging it back in taints the run like the original result.
    boundary: {capabilities: ['read'], decision: 'allow', untrustedSource: true},
    async execute(args, context) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
      if (typeof input.id !== 'string') return textResult('Missing id', true);
      const offset = Math.max(0, integerArg(input.offset) ?? 0);
      const requested = integerArg(input.limit);
      const limit = Math.min(requested && requested > 0 ? requested : DEFAULT_READ_CHARACTERS, MAX_READ_CHARACTERS);
      const stored = await read(context, input.id, offset, limit);
      if (!stored) return textResult(outputUnavailableText(input.id));
      const end = Math.min(stored.characters, offset + stored.page.length);
      return textResult(`[characters ${offset}–${end} of ${stored.characters}]\n${stored.page}`);
    },
  };
}
