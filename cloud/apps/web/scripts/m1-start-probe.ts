// WP-M1: time from a send reaching the API to its provider request and streamed events, with the owner's shape of setup:
// two remote MCP connectors (Exa, Firecrawl) whose HTTP exchanges take MCP_RTT_MS, 15 saved variables/secrets,
// local MiniLM embedder, and optional artificial store latency (STORE_RTT_MS) — using scripted provider only.
// Run from cloud/: `npx tsx apps/web/scripts/m1-start-probe.ts [out.json]`.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
import { selectEmbedder } from '../../api/src/embedding';
import { memoryVectorIndex } from '../../api/src/search-index';
import { catalogKey } from '../../api/src/features/mcp/tools';
import { getRunTiming } from '../../api/src/timing';

const RTT = Number(process.env.MCP_RTT_MS ?? 250);
const STORE_RTT = Number(process.env.STORE_RTT_MS ?? 0);
const SCRIPT = process.env.PROBE_SCRIPT ?? 'text';
const TOOLS: Record<string, string[]> = {
  exa: ['web_search_exa', 'crawling_exa', 'get_code_context_exa', 'company_research_exa', 'linkedin_search_exa', 'deep_researcher_start', 'deep_researcher_check'],
  firecrawl: ['firecrawl_scrape', 'firecrawl_map', 'firecrawl_search', 'firecrawl_crawl', 'firecrawl_check_crawl_status', 'firecrawl_extract', 'firecrawl_deep_research', 'firecrawl_generate_llmstxt'],
};

async function runScenario(opts: { label: string; mcpRttMs: number; storeRttMs: number; embedderMode?: 'minilm' | 'hash' }) {
  let upstreamRequests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const server = url.hostname.split('.')[0]!;
    upstreamRequests++;
    await new Promise((r) => setTimeout(r, opts.mcpRttMs));
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

  const adapters = createLocalAdapters();
  if (opts.storeRttMs > 0) {
    const baseStore = adapters.store;
    const delay = () => new Promise((r) => setTimeout(r, opts.storeRttMs));
    adapters.store = {
      ...baseStore,
      get: async (...a) => { await delay(); return baseStore.get(...a); },
      list: async (...a) => { await delay(); return baseStore.list(...a); },
      put: async (...a) => { await delay(); return baseStore.put(...a); },
      putIfRevision: async (...a) => { await delay(); return baseStore.putIfRevision(...a); },
      delete: async (...a) => { await delay(); return baseStore.delete(...a); },
    };
  }

  const embedder = await selectEmbedder({ PRAXIS_EMBEDDER: opts.embedderMode ?? (process.env.PRAXIS_EMBEDDER ?? 'minilm') }, true);
  const { app, service } = createPraxisApp({
    adapters, local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher,
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

  // Seed realistic saved variables & secrets (triggers MiniLM embedding + reranking).
  const vars = [
    ['deployment region', 'variable', 'eu-central-1 Frankfurt'],
    ['staging cluster', 'variable', 'k8s-staging-west'],
    ['release branch', 'variable', 'redesign/liquid'],
    ['primary database', 'variable', 'postgres-prod-replica'],
    ['analytics endpoint', 'variable', 'https://metrics.praxis.test/v1'],
    ['default timezone', 'variable', 'Europe/Warsaw'],
    ['support email', 'variable', 'ops@praxis.test'],
    ['docs repository', 'variable', 'github.com/praxis/docs'],
    ['billing currency', 'variable', 'EUR'],
    ['model preference', 'variable', 'claude-sonnet-4'],
    ['deployment token', 'secret', 'SYNTH-TOKEN-1'],
    ['firecrawl api key', 'secret', 'SYNTH-KEY-2'],
    ['exa api key', 'secret', 'SYNTH-KEY-3'],
    ['webhook signing secret', 'secret', 'SYNTH-SEC-4'],
    ['registry password', 'secret', 'SYNTH-PWD-5'],
  ] as const;
  for (const [name, kind, value] of vars) {
    await call('/v1/saved-values', { name, kind, value });
  }

  async function send(label: string, cold: boolean, newChat = true, existingChatId?: string) {
    const ctx = { userId: 'local-user', kv: service.adapters.kv } as Parameters<typeof catalogKey>[0];
    if (cold) for (const c of connectors) await service.adapters.kv.del(catalogKey(ctx, c.id));
    const chat = existingChatId
      ? { id: existingChatId }
      : await call('/v1/chats', { type: 'chat.input', title: 'New chat' });
    const before = upstreamRequests;
    const t0 = performance.now();
    const wall0 = Date.now();
    const run = await call('/v1/runs', {
      type: 'run.start',
      chatId: chat.id,
      text: 'check deployment region and write a short release summary',
      clientTurnId: `t-${opts.label}-${label}`,
      script: SCRIPT,
    });
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
    const timing = getRunTiming(run.id);
    return {
      label,
      cold,
      newChat,
      acceptedMs: Math.round(accepted),
      runStartedMs: seen['run.started'],
      providerRequestMs: timing?.providerRequestMs,
      upstreamRequests: upstreamRequests - before,
      timing,
    };
  }

  const results = [];
  results.push(await send('warmup', true, true));
  results.push(await send('cold-new-0', true, true));
  results.push(await send('cold-new-1', true, true));
  results.push(await send('warm-new-0', false, true));
  const followChat = await call('/v1/chats', { type: 'chat.input', title: 'New chat' });
  results.push(await send('cold-followup-turn1', true, true, followChat.id));
  results.push(await send('warm-followup-turn2', false, false, followChat.id));
  return {
    scenario: opts.label,
    mcpRttMs: opts.mcpRttMs,
    storeRttMs: opts.storeRttMs,
    embedder: embedder?.id ?? 'none',
    script: SCRIPT,
    results,
  };
}

const scenarios = [
  await runScenario({ label: `minilm-mcp${RTT}`, mcpRttMs: RTT, storeRttMs: STORE_RTT }),
  await runScenario({ label: `minilm-mcp${RTT}-store40`, mcpRttMs: RTT, storeRttMs: 40 }),
];
const out = { generatedAt: new Date().toISOString(), scenarios };
console.log(JSON.stringify(out, null, 2));
if (process.argv[2]) {
  await mkdir(dirname(process.argv[2]), { recursive: true });
  await writeFile(process.argv[2], JSON.stringify(out, null, 2));
}
process.exit(0);
