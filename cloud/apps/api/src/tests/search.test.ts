import { describe, it, expect } from 'vitest';
import { ChatSchema, MessageSchema } from '@praxis/protocol';
import { createApp } from '../app.js';
import { ApiService } from '../service.js';
import { createMemoryAdapters } from '../adapters/memory.js';
import { storeFromRPC } from '../adapters/convex.js';
import { convexHarness } from '../adapters/testing/convex-harness.js';

for (const mode of ['memory', 'convex'] as const) describe(`search: ${mode}`, () => {
  it('searches all message contents, truncates matched context and isolates owners/deletions', async () => {
    const adapters = createMemoryAdapters();
    if (mode === 'convex') adapters.store = storeFromRPC(convexHarness().rpc);
    const service = new ApiService(adapters, true);
    const { app } = createApp({ service });
    const now = service.now();
    for (const owner of ['local-user', 'other']) {
      await service.seed(owner);
      const chat = ChatSchema.parse({ type: 'chat', id: 'private', mode: 'ask', title: `${owner} title`, createdAt: now, updatedAt: now });
      await service.put(owner, 'chat', chat.id, chat);
      await service.put(owner, 'message', 'message', MessageSchema.parse({ type: 'message', id: 'message', chatId: chat.id,
        role: 'assistant', parts: [{ type: 'text', text: `${'long context '.repeat(60)}Привет мир ${'after '.repeat(90)}` }], createdAt: now, updatedAt: now }));
    }
    const req = (path: string, auth = true) => app.request(path, { headers: auth ? { Authorization: 'Bearer dev-local' } : {} });
    expect((await req('/v1/search?q=мир', false)).status).toBe(401);
    const result = await (await req('/v1/search?q=ПРИВЕТ%20мир&limit=1')).json();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].chat.title).toBe('local-user title');
    expect(result.items[0].snippet).toContain('Привет мир');
    expect(result.items[0].snippet.length).toBeLessThanOrEqual(162);
    expect(result.items[0].snippet).toMatch(/^….*…$/);
    expect((await (await req('/v1/search?q=other')).json()).items).toEqual([]);
    expect((await (await req('/v1/search?q=missing')).json()).items).toEqual([]);
    await service.remove('local-user', 'message', 'message');
    expect((await (await req('/v1/search?q=мир')).json()).items).toEqual([]);
    await service.remove('local-user', 'chat', 'private');
    expect((await (await req('/v1/search?q=title')).json()).items).toEqual([]);
  });
});
