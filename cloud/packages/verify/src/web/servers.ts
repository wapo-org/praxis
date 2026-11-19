import {LOCAL_CONVEX_URL_ENV} from '@praxis/protocol';
import {startAuthBackend} from './convex-auth.js';
import {join} from 'node:path';
import {CLOUD_DIR, LOOPBACK_HOST} from '../constants.js';
import {assertPortFree, startServer, waitForUrl, type ManagedServer} from '../proc.js';

export interface LocalStack {
  base: string;
  api: string;
  convexUrl?: string;
  stop(): Promise<void>;
}

const BIN = join(CLOUD_DIR, 'node_modules', '.bin');
/** Build inputs `apps/web/vite.config.ts` reads to compile the preview OAuth simulator in. */
const LOCAL_PREVIEW_BUILD_ENV = {VERCEL_ENV: 'preview', PRAXIS_PREVIEW_MOCK_OAUTH: 'google,apple'} as const;

/** In-memory store and the hash embedder: no state on disk and no model download, so runs repeat exactly. */
function apiEnv(apiPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, PORT: String(apiPort), HOST: LOOPBACK_HOST, PRAXIS_EMBEDDER: 'hash'};
  delete env.PRAXIS_LOCAL_DATA_DIR;
  return env;
}

export async function startApi(apiPort: number, logDirectory: string, convexUrl?: string): Promise<{api: string; server: ManagedServer}> {
  await assertPortFree(apiPort);
  const api = `http://${LOOPBACK_HOST}:${apiPort}`;
  const server = startServer('api', join(BIN, 'tsx'), ['src/local.ts'], {cwd: join(CLOUD_DIR, 'apps', 'api'), env: {...apiEnv(apiPort), ...(convexUrl ? {[LOCAL_CONVEX_URL_ENV]: convexUrl} : {})}, logFile: join(logDirectory, 'api.log')});
  try {
    await waitForUrl(`${api}/health`, undefined, () => !server.exited);
  } catch (error) {
    await server.stop();
    throw error;
  }
  return {api, server};
}

/** A failed startup must not leave a partial stack running. */
export async function startLocalStack(ports: {web: number; api: number}, logDirectory: string): Promise<LocalStack> {
  await assertPortFree(ports.web);
  const base = `http://${LOOPBACK_HOST}:${ports.web}`;
  const auth = await startAuthBackend(ports.api, base, logDirectory);
  let startedApi;
  try {
    startedApi = await startApi(ports.api, logDirectory, auth.url);
  } catch (error) {
    await auth.stop();
    throw error;
  }
  const {api, server: apiServer} = startedApi;
  const web = startServer('web', join(BIN, 'vite'), ['--port', String(ports.web), '--host', LOOPBACK_HOST, '--strictPort'], {
    cwd: join(CLOUD_DIR, 'apps', 'web'),
    // The preview OAuth simulation keeps local flows off real Google and Apple consent pages.
    env: {...process.env, VITE_API_BASE_URL: '', VITE_API_PROXY_TARGET: api, VITE_CONVEX_URL: auth.url, ...LOCAL_PREVIEW_BUILD_ENV},
    logFile: join(logDirectory, 'web.log'),
  });
  const stop = async () => {
    await web.stop();
    await apiServer.stop();
    await auth.stop();
  };
  try {
    await waitForUrl(`${base}/`, undefined, () => !web.exited);
  } catch (error) {
    await stop();
    throw error;
  }
  return {base, api, convexUrl: auth.url, stop};
}
