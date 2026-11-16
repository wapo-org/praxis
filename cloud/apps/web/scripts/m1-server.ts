import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
import { selectEmbedder } from '../../api/src/embedding';
import { memoryVectorIndex } from '../../api/src/search-index';
import { catalogKey } from '../../api/src/features/mcp/tools';

const RTT = Number(process.env.MCP_RTT_MS ?? 800);
const port = Number(process.env.API_PORT ?? 8891);
const TOOLS: Record<string, string[]> = {
  exa: ['web_search_exa', 'crawling_exa', 'get_code_context_exa', 'company_research_exa', 'linkedin_search_exa', 'deep_researcher_start', 'deep_researcher_check'],
  firecrawl: ['firecrawl_scrape', 'firecrawl_map', 'firecrawl_search', 'firecrawl_crawl', 'firecrawl_check_crawl_status', 'firecrawl_extract', 'firecrawl_deep_research', 'firecrawl_generate_llmstxt'],
};
const SEARCH = 'Title: The Forgetting Code by Malena Salazar Maciá : Clarkesworld Magazine\nURL: https://clarkesworldmagazine.com/macia_04_26/\nHighlights:\nThere is no formula for forgetting.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const server = url.hostname.split('.')[0]!;
  if (!url.hostname.endsWith('.mcp.test')) throw new Error(`Unexpected upstream ${url}`);
  await sleep(RTT);
  if (init?.method === 'DELETE') return new Response(null, { status: 200 });
  const req = JSON.parse(String(init?.body || '{}'));
  if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (req.method === 'tools/call') await sleep(4000 - RTT);
  const result = req.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } }
    : req.method === 'tools/list'
      ? { tools: (TOOLS[server] ?? []).map((name) => ({ name, description: `${name.replaceAll('_', ' ')}: search, crawl and read the web`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } })) }
      : req.method === 'tools/call'
        ? { content: [{ type: 'text', text: SEARCH }], isError: false }
        : {};
  return Response.json({ jsonrpc: '2.0', id: req.id, result });
};
const embedder = await selectEmbedder({ PRAXIS_EMBEDDER: process.env.PRAXIS_EMBEDDER }, true);
const { app, service } = createPraxisApp({
  adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher,
  ...(embedder ? { search: { embedder, vectors: memoryVectorIndex() } } : {}),
  modules: localModules(`http://127.0.0.1:${port}`),
  allowedOrigins: [process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5261'],
});
await service.seed('local-user');
app.post('/__test/m1/cold', async (c) => {
  const { userId } = await c.req.json<{ userId: string }>();
  const ctx = { userId, kv: service.adapters.kv } as Parameters<typeof catalogKey>[0];
  const rows = await service.adapters.store.list(userId, 'connector');
  for (const row of rows) await service.adapters.kv.del(catalogKey(ctx, row.id));
  return c.json({ cleared: rows.length });
});
const api = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
console.info(`M1 harness API http://127.0.0.1:${port} (MCP RTT ${RTT} ms, embedder ${embedder?.id ?? 'none'})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { api.close(); process.exit(0); });
