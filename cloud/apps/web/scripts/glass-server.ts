// Test harness: real local Hono API served inside Vite on the single assigned port.
import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { getRequestListener } from '@hono/node-server';
import { createPraxisApp } from '../../api/src/server';
import { createLocalAdapters } from '../../api/src/local-memory';
import { localModules } from '../../api/src/modules';
const { app, service } = createPraxisApp({ adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),modules:localModules('http://127.0.0.1:5191') });
await service.seed('local-user');
const listener=getRequestListener(app.fetch);
const server=await createServer({root:'apps/web',server:{host:'127.0.0.1',port:5191,strictPort:true},plugins:[{name:'local-glass-verification-api',configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/v1/')||req.url==='/health')void listener(req,res);else next();});}}]});
await server.listen();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void server.close().then(()=>process.exit(0));});
