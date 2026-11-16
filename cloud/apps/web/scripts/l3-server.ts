import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { serve } from '@hono/node-server';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
import { fixtureFor, tokenize } from './l3-fixtures';

const apiPort = Number(process.env.API_PORT ?? 8871), webPort = Number(process.env.WEB_PORT ?? 5241);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const UPSTREAM = 'openrouter.ai';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

const upstream: typeof fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== UPSTREAM) return fetch(input, init);
  if (url.pathname.endsWith('/key')) return Response.json({data:{label:'L3 fixture'}});
  if (url.pathname.endsWith('/models')) return Response.json({ data: ['l3-80-150', 'l3-100', 'l3-150', 'l3-40'].map((id) => ({ id, context_length:128000, pricing:{prompt:'0.000001',completion:'0.000002'} })) });
  const body = JSON.parse(String(init?.body ?? '{}'));
  const messages: Array<{ role: string; content: unknown }> = body.messages ?? [];
  const system = textOf(messages.find((m) => m.role === 'system')?.content);
  const prompt = textOf([...messages].reverse().find((m) => m.role === 'user')?.content);
  const frame = (delta: object, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
  const encoder = new TextEncoder();
  // Title requests and capability probes answer at once.
  if (system.startsWith('Return only a short') || !body.stream) {
    const title = prompt.includes('nested') ? 'Nested Lists Test' : 'Something Long Formatting Test';
    if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: title }, finish_reason: 'stop' }] });
    return new Response(frame({ content: title }) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const [, low = '80', high = low] = /^l3-(\d+)(?:-(\d+))?$/.exec(String(body.model)) ?? [];
  const lo = Number(low), hi = Number(high);
  const { text, reasoning } = fixtureFor(prompt);
  // Deterministic jitter, so a before/after pair sees the same arrival pattern.
  let seed = 1234567;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const signal = init?.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const started = performance.now();
        let due = 0;
        const emit = async (delta: object) => {
          due += 1000 / (lo + random() * (hi - lo));
          const wait = started + due - performance.now();
          if (wait > 1) await sleep(wait);
          if (signal?.aborted) throw new Error('aborted');
          controller.enqueue(encoder.encode(frame(delta)));
        };
        if (reasoning) {
          for (const token of tokenize(reasoning)) await emit({ reasoning_content: token });
          // A model thinks for a while before it answers; the work header is on screen for this long.
          due += Number(process.env.L3_THINK_MS ?? 2500);
        }
        for (const token of tokenize(text)) await emit({ content: token });
        controller.enqueue(encoder.encode(frame({}, 'stop') + 'data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
};

const { app, service } = createPraxisApp({
  adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher: upstream,
  modules: localModules(apiOrigin), allowedOrigins: [`http://127.0.0.1:${webPort}`],
});
await service.seed('local-user');
const api = serve({ fetch: app.fetch, port: apiPort, hostname: '127.0.0.1' });
process.env.VITE_API_PROXY_TARGET = apiOrigin;
// A local image for the formatting fixture (images over the network are not part of the test).
const IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="200"><rect width="560" height="200" rx="14" fill="#c9d6df"/><circle cx="100" cy="100" r="46" fill="#52616b"/><rect x="180" y="70" width="300" height="18" rx="9" fill="#52616b" opacity=".5"/><rect x="180" y="110" width="220" height="18" rx="9" fill="#52616b" opacity=".35"/></svg>`;
const web = await createServer({ root: 'apps/web', server: { host: '127.0.0.1', port: webPort, strictPort: true }, plugins: [{ name: 'l3-image', configureServer(vite) { vite.middlewares.use('/__l3/image.svg', (_req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.end(IMAGE); }); } }] });
await web.listen();
console.info(`L3 harness: web http://127.0.0.1:${webPort} → API ${apiOrigin} (upstream https://${UPSTREAM}/v1)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { api.close(); void web.close().then(() => process.exit(0)); });
