// Test harness: real local Hono API served inside Vite on the single assigned port.
import { advance, fixtureFetch } from './x1-fixtures';
import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { getRequestListener } from '@hono/node-server';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
const { app, service } = createPraxisApp({ adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),fetcher:fixtureFetch,modules:service=>localModules('http://127.0.0.1:5191')(service).map(module=>({...module,routes:module.routes?(context=>module.routes!(async request=>({...await context(request),egress:fixtureFetch}))):undefined})) });
await service.seed('local-user');
app.post('/__test/x1/advance',async c=>{advance();const {registryId}=await c.req.json();await service.adapters.kv.del(JSON.stringify(['tools','registry','local-user',registryId,'https://example.com/x1/skills']));return c.json({ok:true});});
const listener=getRequestListener(app.fetch);
const server=await createServer({root:'apps/web',server:{host:'127.0.0.1',port:5191,strictPort:true},plugins:[{name:'local-glass-verification-api',configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/v1/')||req.url==='/health'||req.url?.startsWith('/__test/'))void listener(req,res);else next();});}}]});
await server.listen();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void server.close().then(()=>process.exit(0));});
