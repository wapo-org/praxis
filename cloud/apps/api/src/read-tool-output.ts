import {readWebOutput} from './features/web/output.js';
import {toolOutputReaderTool, type AgentTool, type ToolOutputReader} from '@praxis/agent';
import type {ApiService} from './service.js';

export {MAX_READ_CHARACTERS} from '@praxis/agent';

/** Pages through spilled tool results in this chat; a missing or partial output reads as no longer available. */
export function readToolOutputTool(service: ApiService): AgentTool {
  const {store} = service.adapters;
  const read: ToolOutputReader = async (context, id, offset, limit) => {
    const row = await store.get(context.userId, 'output', id);
    if (!row || row.deleted || row.value.chatId !== context.chatId) return undefined;
    if (row.value.chunkIds) return readWebOutput(store, context.userId, context.chatId, row.value, offset, limit);
    const text = String(row.value.text ?? '');
    return {page: text.slice(offset, offset + limit), characters: text.length};
  };
  return toolOutputReaderTool(read);
}
