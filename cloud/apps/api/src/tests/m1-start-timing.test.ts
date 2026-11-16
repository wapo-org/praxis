import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPraxisApp } from '../server.js';
import { createLocalAdapters } from '../local-memory.js';
import { localModules } from '../modules.js';
import { selectEmbedder } from '../embedding.js';
import { memoryVectorIndex } from '../search-index.js';
import { catalogKey } from '../features/mcp/tools.js';
import { getRunTiming } from '../timing.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M1 run start timing and critical-path isolation', () => {
  it('records all timing steps and keeps variablesTouch, titleGeneration, and stale MCP SWR refresh off the provider request critical path', async () => {
    let mcpHits = 0;
    let fakeLlmCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'openrouter.ai') {
        if (url.pathname.endsWith('/key')) return Response.json({data:{label:'test'}});
        if (url.pathname.endsWith('/models')) {
          return Response.json({ data: [{ id: 'fake-model', context_length:128000, pricing:{prompt:'0.000001',completion:'0.000002'},supported_parameters:['tools'] }] });
        }
        fakeLlmCalls++;
        const req = JSON.parse(String(init?.body || '{}'));
        const isTitle = String(req.messages?.[0]?.content ?? '').includes('title generator');
        if (isTitle) {
          await sleep(250);
          return Response.json({
            choices: [{ index: 0, message: { role: 'assistant', content: 'Deployment Region Check' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          });
        }
        const sse =
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n';
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      mcpHits++;
      await sleep(220);
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const req = JSON.parse(String(init?.body || '{}'));
      if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result =
        req.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'exa', version: '1' } }
          : req.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'web_search_exa',
                    description: 'Search the web',
                    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                  },
                ],
              }
            : {};
      return Response.json({ jsonrpc: '2.0', id: req.id, result });
    };

    const base = createLocalAdapters();
    const storeRtt = 25;
    const delayedStore = {
      ...base.store,
      get: async (...a: Parameters<typeof base.store.get>) => {
        await sleep(storeRtt);
        return base.store.get(...a);
      },
      list: async (...a: Parameters<typeof base.store.list>) => {
        await sleep(storeRtt);
        return base.store.list(...a);
      },
      put: async (...a: Parameters<typeof base.store.put>) => {
        await sleep(storeRtt);
        return base.store.put(...a);
      },
      putIfRevision: async (...a: Parameters<typeof base.store.putIfRevision>) => {
        await sleep(storeRtt);
        return base.store.putIfRevision(...a);
      },
      delete: async (...a: Parameters<typeof base.store.delete>) => {
        await sleep(storeRtt);
        return base.store.delete(...a);
      },
    };

    const embedder = await selectEmbedder({ PRAXIS_EMBEDDER: 'hash' }, true);
    const { app, service } = createPraxisApp({
      adapters: { ...base, store: delayedStore },
      local: true,
      encryptionKey: randomBytes(32).toString('base64'),
      fetcher,
      ...(embedder ? { search: { embedder, vectors: memoryVectorIndex() } } : {}),
      modules: localModules('http://127.0.0.1:1'),
    });

    await service.seed('local-user');
    const auth = { authorization: 'Bearer dev-local', 'content-type': 'application/json' };
    const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const res = await app.request(path, {
        method,
        headers: auth,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${await res.text()}`);
      return res.json() as Promise<any>;
    };

    await call('/v1/consents', { type: 'consent', host: 'exa.mcp.test', allowed: true });
    await call('/v1/consents', { type: 'consent', host: 'llm.example.test', allowed: true });
    const connector = await call('/v1/connectors', {
      type: 'connector.input',
      name: 'Exa',
      url: 'https://exa.mcp.test/mcp',
      trusted: true,
    });
    await call('/v1/model-key', {method:'paste',apiKey:'sk-or-test-123456'});
    await call('/v1/saved-values', {
      name: 'deployment region',
      kind: 'variable',
      value: 'eu-central-1',
    });

    // Seed a stale (beyond 60 s SWR window, within 24 h KV TTL) MCP catalog entry so send 1 hits SWR.
    const ctx = { userId: 'local-user', kv: service.adapters.kv } as Parameters<typeof catalogKey>[0];
    await service.adapters.kv.set(
      catalogKey(ctx, connector.id),
      {
        url: connector.url,
        transport: connector.transport,
        tools: [
          {
            name: 'web_search_exa',
            description: 'Search the web',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        resources: false,
        fetchedAt: Date.now() - 120_000,
      },
      86_400,
      'local-user',
    );

    const chat = await call('/v1/chats', {
      type: 'chat.input',
      title: 'New chat',
      modelId: 'fake-model',
    });

    const hitsBefore = mcpHits;
    const run = await call('/v1/runs', {
      type: 'run.start',
      chatId: chat.id,
      text: 'check deployment region',
      clientTurnId: 'm1-timing-turn-1',
    });

    await service.drain();
    const timing = getRunTiming(run.id);
    expect(timing).toBeDefined();
    expect(fakeLlmCalls).toBeGreaterThanOrEqual(1);

    const steps = timing!.steps;
    expect(steps.notes).toBeDefined();
    expect(steps.variables).toBeDefined();
    expect(steps.variablesTouch).toBeDefined();
    expect(steps.mcpConnectorList).toBeDefined();
    expect(steps.mcpCatalog).toBeDefined();
    expect(steps.toolCatalog).toBeDefined();
    expect(steps.toolSelection).toBeDefined();
    expect(steps.modelMetadata).toBeDefined();
    expect(steps.titleGeneration).toBeDefined();

    // POST returned before background title generation and before long MCP/provider work.
    expect(timing!.postResponseMs!).toBeLessThan(timing!.providerRequestMs!);
    expect(steps.titleGeneration!.endMs).toBeGreaterThan(timing!.postResponseMs!);

    expect(steps.mcpCatalog!.durationMs).toBeLessThan(150);
    expect(mcpHits).toBeGreaterThan(hitsBefore);

    expect(steps.variablesTouch!.startMs).toBeGreaterThanOrEqual(steps.variables!.endMs - 5);
  });
});
