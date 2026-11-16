import {join} from 'node:path';
import {CLOUD_DIR, LOOPBACK_HOST} from '../constants.js';
import {assertPortFree, startServer, waitForUrl, type ManagedServer} from '../proc.js';

export interface LocalStack {
  base: string;
  api: string;
  stop(): Promise<void>;
}

const BIN = join(CLOUD_DIR, 'node_modules', '.bin');

/** In-memory store and the hash embedder: no state on disk and no model download, so runs repeat exactly. */
function apiEnv(apiPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, PORT: String(apiPort), HOST: LOOPBACK_HOST, PRAXIS_EMBEDDER: 'hash'};
  delete env.PRAXIS_LOCAL_DATA_DIR;
  return env;
}

export async function startApi(apiPort: number, logDirectory: string): Promise<{api: string; server: ManagedServer}> {
  await assertPortFree(apiPort);
  const api = `http://${LOOPBACK_HOST}:${apiPort}`;
  const server = startServer('api', join(BIN, 'tsx'), ['src/local.ts'], {cwd: join(CLOUD_DIR, 'apps', 'api'), env: apiEnv(apiPort), logFile: join(logDirectory, 'api.log')});
  try {
    await waitForUrl(`${api}/health`, undefined, () => !server.exited);
  } catch (error) {
    await server.stop();
    throw error;
  }
  return {api, server};
}

/** Both servers or neither: a half-started stack is stopped before the error propagates. */
export async function startLocalStack(ports: {web: number; api: number}, logDirectory: string): Promise<LocalStack> {
  await assertPortFree(ports.web);
  const {api, server: apiServer} = await startApi(ports.api, logDirectory);
  const base = `http://${LOOPBACK_HOST}:${ports.web}`;
  const web = startServer('web', join(BIN, 'vite'), ['--port', String(ports.web), '--host', LOOPBACK_HOST, '--strictPort'], {
    cwd: join(CLOUD_DIR, 'apps', 'web'),
    env: {...process.env, VITE_API_PROXY_TARGET: api},
    logFile: join(logDirectory, 'web.log'),
  });
  const stop = async () => {
    await web.stop();
    await apiServer.stop();
  };
  try {
    await waitForUrl(`${base}/`, undefined, () => !web.exited);
  } catch (error) {
    await stop();
    throw error;
  }
  return {base, api, stop};
}
