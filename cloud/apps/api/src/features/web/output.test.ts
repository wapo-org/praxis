import {expect, it} from 'vitest';
import {createLocalAdapters} from '../../local-memory.js';
import {readWebOutput, spillWebOutput} from './output.js';
import {WEB_OUTPUT_CHUNK_CHARACTERS_MAX as CHUNK_MAX} from '@praxis/protocol';
it('spills a two-megabyte page below the Convex document cap and pages across chunk boundaries with owner/chat isolation', async () => {
  const {store} = createLocalAdapters();
  await store.put('user', 'run', 'run', {chatId: 'chat'});
  const text = 'a'.repeat(CHUNK_MAX - 3) + 'boundary' + 'b'.repeat(2_000_000 - CHUNK_MAX);
  const id = await spillWebOutput(store, {userId: 'user', runId: 'run', callId: 'call', text});
  const manifest = (await store.get('user', 'output', id))!.value;
  expect(manifest.text).toBeUndefined();
  for (const row of await store.list('user', 'outputChunk')) expect(Buffer.byteLength(JSON.stringify(row.value))).toBeLessThan(1_000_000);
  expect(await readWebOutput(store, 'user', 'chat', manifest, CHUNK_MAX - 3, 8)).toEqual({page: 'boundary', characters: text.length});
  await expect(readWebOutput(store, 'other', 'chat', manifest, 0, 10)).rejects.toThrow();
  await expect(readWebOutput(store, 'user', 'other', manifest, 0, 10)).rejects.toThrow();
});
