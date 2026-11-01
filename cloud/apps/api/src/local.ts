import {randomBytes} from 'node:crypto';
import {serve} from '@hono/node-server';
import {createLocalAdapters} from './local-memory.js';
import {createPraxisApp} from './server.js';
import {localModules} from './modules.js';
if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw new Error('Local development server cannot run in production');
// Log fatal errors before the process goes away; a background rejection is logged and the dev server keeps serving.
process.on('unhandledRejection',reason=>{console.error('[praxis-local] unhandledRejection:',reason instanceof Error?reason.stack:reason);});
process.on('uncaughtException',error=>{console.error('[praxis-local] uncaughtException (exiting):',error.stack??error);process.exit(1);});
const port=Number(process.env.PORT??8787);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const origins=(process.env.PRAXIS_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
const {app,service}=createPraxisApp({adapters:createLocalAdapters(),local:true,encryptionKey:process.env.PRAXIS_ENCRYPTION_KEYS??process.env.PRAXIS_ENCRYPTION_KEY??randomBytes(32).toString('base64'),modules:localModules(`http://127.0.0.1:${port}`),...(origins.length?{allowedOrigins:[...origins,'http://localhost:5173','http://127.0.0.1:5173']}:{})});
await service.seed('local-user');
const server=serve({fetch:app.fetch,port,hostname:process.env.HOST??'127.0.0.1'},()=>{console.info(`Praxis local API: http://127.0.0.1:${port} (Bearer dev-local)`);});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
