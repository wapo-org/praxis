// WP-M1: time from a send reaching the API to its first streamed events, with the owner's shape of setup:
// two remote MCP connectors (Exa, Firecrawl) whose every HTTP exchange takes MCP_RTT_MS, and the local MiniLM
// embedder. Run from cloud/: `npx tsx apps/web/scripts/m1-start-probe.ts [out.json]`.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
import { selectEmbedder } from '../../api/src/embedding';
import { memoryVectorIndex } from '../../api/src/search-index';
import { catalogKey } from '../../api/src/features/mcp/tools';

const RTT = Number(process.env.MCP_RTT_MS ?? 250);
const SCRIPT = process.env.PROBE_SCRIPT ?? 'text';
const TOOLS: Record<string, string[]> = {
  exa: ['web_search_exa', 'crawling_exa', 'get_code_context_exa', 'company_research_exa', 'linkedin_search_exa', 'deep_researcher_start', 'deep_researcher_check'],
  firecrawl: ['firecrawl_scrape', 'firecrawl_map', 'firecrawl_search', 'firecrawl_crawl', 'firecrawl_check_crawl_status', 'firecrawl_extract', 'firecrawl_deep_research', 'firecrawl_generate_llmstxt'],
};
let upstreamRequests = 0;
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const server = url.hostname.split('.')[0]!;
  upstreamRequests++;
  await new Promise((r) => setTimeout(r, RTT));
  if (init?.method === 'DELETE') return new Response(null, { status: 200 });
  const req = JSON.parse(String(init?.body || '{}'));
  if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
  const result = req.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } }
    : req.method === 'tools/list'
      ? { tools: (TOOLS[server] ?? []).map((name) => ({ name, description: `${name.replaceAll('_', ' ')}: search, crawl and read the web for the user`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })) }
      : {};
  return Response.json({ jsonrpc: '2.0', id: req.id, result });
};

const embedder = process.env.PRAXIS_EMBEDDER === 'hash' ? await selectEmbedder({ PRAXIS_EMBEDDER: 'hash' }, true) : await selectEmbedder({}, true);
const { app, service } = createPraxisApp({
  adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher,
  ...(embedder ? { search: { embedder, vectors: memoryVectorIndex() } } : {}),
  modules: localModules('http://127.0.0.1:1'),
} as Parameters<typeof createPraxisApp>[0]);
await service.seed('local-user');
const auth = { authorization: 'Bearer dev-local', 'content-type': 'application/json' };
const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const res = await app.request(path, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};
const connectors = [];
for (const name of ['exa', 'firecrawl']) {
  await call('/v1/consents', { type: 'consent', host: `${name}.mcp.test`, allowed: true });
  connectors.push(await call('/v1/connectors', { type: 'connector.input', name: name[0]!.toUpperCase() + name.slice(1), url: `https://${name}.mcp.test/mcp`, trusted: true }));
}
// A little real history, so tool ranking reads and embeds what it would in a used account.
async function send(label: string, cold: boolean) {
  const ctx = { userId: 'local-user', kv: service.adapters.kv } as Parameters<typeof catalogKey>[0];
  if (cold) for (const c of connectors) await service.adapters.kv.del(catalogKey(ctx, c.id));
  const chat = await call('/v1/chats', { type: 'chat.input', title: 'New chat' });
  const before = upstreamRequests;
  const t0 = performance.now();
  const wall0 = Date.now();
  const run = await call('/v1/runs', { type: 'run.start', chatId: chat.id, text: 'write something semi long', clientTurnId: `t-${label}`, script: SCRIPT });
  const accepted = performance.now() - t0;
  const seen: Record<string, number> = {};
  for (let i = 0; i < 2000 && !seen['run.started']; i++) {
    for (const r of await service.adapters.events.read('local-user', `run:${run.id}`, 0, 100)) {
      const type = (r.payload as any).event.type as string;
      seen[type] ??= Date.parse((r.payload as any).createdAt) - wall0;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await service.drain();
  return { label, cold, acceptedMs: Math.round(accepted), firstEvent: Object.entries(seen).sort((a, b) => a[1] - b[1])[0], runStartedMs: seen['run.started'], upstreamRequests: upstreamRequests - before, events: seen };
}
const results = [];
results.push(await send('warmup', true));
for (let i = 0; i < 3; i++) results.push(await send(`cold-${i}`, true));
for (let i = 0; i < 3; i++) results.push(await send(`warm-${i}`, false));
const out = { rttMs: RTT, embedder: embedder?.id ?? 'none', script: SCRIPT, results };
console.log(JSON.stringify(out, null, 1));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(out, null, 1));
process.exit(0);
