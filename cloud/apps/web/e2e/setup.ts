import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLocalStack } from '../../../packages/verify/src/web/servers.js';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from '../../../packages/verify/src/constants.js';

export default async function setup() {
  if (process.env.PW_BASE_URL) {
    if (!process.env.PW_CONVEX_URL) throw new Error('Existing browser stacks require PW_CONVEX_URL and the isolated verification auth deployment');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'praxis-browser-'));
  const stack = await startLocalStack({ web: DEFAULT_WEB_PORT, api: DEFAULT_API_PORT }, directory);
  process.env.PW_CONVEX_URL = stack.convexUrl;
  return () => stack.stop();
}
