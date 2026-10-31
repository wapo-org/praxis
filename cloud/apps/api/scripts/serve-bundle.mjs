// Serves the production bundle (dist/index.mjs) with memory adapters for a local smoke run.
// PRAXIS_LOCAL_SMOKE is refused by the bundle itself when VERCEL or NODE_ENV=production is set.
process.env.PRAXIS_LOCAL_SMOKE = '1';
const {serve} = await import('@hono/node-server');
const mod = await import('../dist/index.mjs');
const port = Number(process.env.PORT ?? 8787);
serve({fetch: mod.default.fetch, port, hostname: '127.0.0.1'}, () => console.info(`bundle smoke server http://127.0.0.1:${port}`));
