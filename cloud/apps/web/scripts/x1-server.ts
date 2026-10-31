// Test harness: the real local API (dev:local adapters, deterministic upstreams) on API_PORT, Vite on WEB_PORT.
// Run from cloud/: `npx tsx apps/web/scripts/x1-server.ts`, then `node apps/web/scripts/x1-check.mjs`.
import { advance, fixtureFetch } from './x1-fixtures';
import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { serve } from '@hono/node-server';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
const apiPort = Number(process.env.API_PORT ?? 8821), webPort = Number(process.env.WEB_PORT ?? 5195);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const { app, service } = createPraxisApp({ adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),fetcher:fixtureFetch,modules:service=>localModules(apiOrigin)(service).map(module=>({...module,routes:module.routes?(context=>module.routes!(async request=>({...await context(request),egress:fixtureFetch}))):undefined})) });
await service.seed('local-user');
app.post('/__test/x1/advance',async c=>{advance();const {registryId}=await c.req.json();await service.adapters.kv.del(JSON.stringify(['tools','registry','local-user',registryId,'https://example.com/x1/skills']));return c.json({ok:true});});
const api = serve({ fetch: app.fetch, port: apiPort, hostname: '127.0.0.1' });
// The browser talks to the API directly (local CORS), as with `dev:local` + `VITE_API_BASE_URL`; uploads then carry auth.
process.env.VITE_API_PROXY_TARGET = apiOrigin;
process.env.VITE_API_BASE_URL = apiOrigin;
const web = await createServer({ root:'apps/web', server:{ host:'127.0.0.1', port:webPort, strictPort:true, proxy:{ '/__test':{ target:apiOrigin } } } });
await web.listen();
console.info(`X1 harness: web http://127.0.0.1:${webPort} → API ${apiOrigin}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{api.close();void web.close().then(()=>process.exit(0));});
