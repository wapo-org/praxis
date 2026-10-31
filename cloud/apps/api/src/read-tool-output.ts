import {MAX_RESULT_CHARACTERS, textResult, type AgentTool} from '@praxis/agent';
import type {ApiService} from './service.js';

/** A page plus its header must stay under the spill threshold, or reading would spill (and truncate) once more. */
export const MAX_READ_CHARACTERS = MAX_RESULT_CHARACTERS - 200;
const DEFAULT_READ = 20_000;

/** Port of AgentCore ReadToolOutputTool: pages through a spilled (truncated) tool result of this conversation. */
export function readToolOutputTool(service: ApiService): AgentTool {
  return {
    spec: {
      type: 'tool.spec', name: 'read_tool_output', source: {type: 'builtin'}, traits: ['readOnly', 'idempotent'],
      description: 'Read more of a tool result that was truncated. Pass the id from the truncation note and a character offset.',
      inputSchema: {type: 'object', properties: {id: {type: 'string', description: 'Id from the truncation note'}, offset: {type: 'integer', description: 'Character offset to start at'}, limit: {type: 'integer', description: `Characters to read (default ${DEFAULT_READ}, at most ${MAX_READ_CHARACTERS})`}}, required: ['id', 'offset']},
    },
    async execute(args, context) {
      const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as {id?: unknown; offset?: unknown; limit?: unknown};
      if (typeof a.id !== 'string') return textResult('Missing id', true);
      const offset = Math.max(0, Number.isInteger(a.offset) ? (a.offset as number) : 0);
      const limit = Math.min(Number.isInteger(a.limit) && (a.limit as number) > 0 ? (a.limit as number) : DEFAULT_READ, MAX_READ_CHARACTERS);
      const row = await service.adapters.store.get(context.userId, 'output', a.id);
      if (!row || row.deleted || row.value.chatId !== context.chatId) return textResult(`No stored output with id ${a.id}. Stored output is kept per conversation.`, true);
      const text = String(row.value.text ?? '');
      const page = text.slice(offset, offset + limit);
      return textResult(`[characters ${offset}–${Math.min(text.length, offset + page.length)} of ${text.length}]\n${page}`);
    },
  };
}
