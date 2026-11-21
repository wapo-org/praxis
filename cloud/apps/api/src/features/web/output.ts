import {WEB_OUTPUT_CHUNK_CHARACTERS_MAX as CHUNK_MAX, WebOutputManifestSchema, type JsonObject} from '@praxis/protocol';
import type {Store} from '../../contracts.js';

export async function spillWebOutput(store: Store, input: {userId: string; runId: string; callId: string; text: string}): Promise<string> {
  const id = crypto.randomUUID();
  const run = await store.get(input.userId, 'run', input.runId);
  if (!run || run.deleted || typeof run.value.chatId !== 'string') throw new Error('Web output run is unavailable');
  const chatId = run.value.chatId;
  const chunkIds: string[] = [];
  for (let at = 0; at < input.text.length; at += CHUNK_MAX) {
    const chunkId = `${id}:${chunkIds.length}`;
    await store.put(input.userId, 'outputChunk', chunkId, {chatId, text: input.text.slice(at, at + CHUNK_MAX)}, {parentId: id});
    chunkIds.push(chunkId);
  }
  await store.put(input.userId, 'output', id, {type: 'tool.output', id, runId: input.runId,
    chatId, callId: input.callId, chunkIds, characters: input.text.length});
  return id;
}
/** Undefined when a chunk is gone or from another chat, so the reader answers "no longer available" instead of failing. */
export async function readWebOutput(store: Store, userId: string, chatId: string, manifest: JsonObject,
  offset: number, limit: number): Promise<{page: string; characters: number} | undefined> {
  const {chunkIds, characters} = WebOutputManifestSchema.parse(manifest);
  const end = Math.min(characters, offset + limit);
  const pages: string[] = [];
  for (let index = Math.floor(offset / CHUNK_MAX); index * CHUNK_MAX < end; index++) {
    const id = chunkIds[index];
    const chunk = id === undefined ? null : await store.get(userId, 'outputChunk', id);
    if (!chunk || chunk.deleted || chunk.value.chatId !== chatId || typeof chunk.value.text !== 'string') return undefined;
    const startAt = Math.max(0, offset - index * CHUNK_MAX);
    pages.push(chunk.value.text.slice(startAt, Math.min(CHUNK_MAX, end - index * CHUNK_MAX)));
  }
  return {page: pages.join(''), characters};
}
