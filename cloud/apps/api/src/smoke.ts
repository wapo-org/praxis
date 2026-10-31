import {randomBytes} from 'node:crypto';
import {createLocalAdapters} from './local-memory.js';
import {localModules} from './modules.js';
import {createPraxisApp} from './server.js';

/** Bundle smoke only: the bundled handler with memory adapters and dev auth. createApp refuses local mode on Vercel. */
export function createSmokeApp() {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('Smoke app is not allowed in production');
  const port = Number(process.env.PORT ?? 8787);
  const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), modules: localModules(`http://127.0.0.1:${port}`)});
  void service.seed('local-user');
  return app;
}
