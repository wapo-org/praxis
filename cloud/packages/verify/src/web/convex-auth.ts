import { access, copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { AUTH_ENV } from '../../../../convex/authConstants.js';
import { VERIFY_AUTH, AUTH_BACKEND_PORT_OFFSET, AUTH_SITE_PORT_OFFSET, AUTH_FIXTURE_FILES, AUTH_START_TIMEOUT_MS, AUTH_FUNCTION_POLL_MS } from '../../../../verify/auth/constants.js';
import { CLOUD_DIR, LOOPBACK_HOST } from '../constants.js';
import { assertPortFree, runCommand, startServer, waitForUrl, type ManagedServer } from '../proc.js';

const Ready = makeFunctionReference<'query'>('fixtureReady:ready');
const IsAuthenticated = makeFunctionReference<'query'>('auth:isAuthenticated');

async function waitForFunction(client: ConvexHttpClient, reference: typeof Ready, alive: () => boolean) {
  const deadline = Date.now() + AUTH_START_TIMEOUT_MS;
  for (;;) {
    if (!alive()) throw new Error('Local auth backend exited before deployment');
    try {
      await client.query(reference, {});
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('Local auth functions did not deploy');
      await sleep(AUTH_FUNCTION_POLL_MS);
    }
  }
}

/** Deployment and environment writes must not overlap; the auth modules are mounted only after configuration is persisted. */
export async function startAuthBackend(apiPort: number, base: string, directory: string) {
  const port = apiPort + AUTH_BACKEND_PORT_OFFSET;
  const sitePort = apiPort + AUTH_SITE_PORT_OFFSET;
  await assertPortFree(port);
  await assertPortFree(sitePort);
  const project = await mkdtemp(join(tmpdir(), 'praxis-convex-auth-'));
  const functions = join(project, 'convex');
  await mkdir(functions, { recursive: true });
  await symlink(join(CLOUD_DIR, 'node_modules'), join(project, 'node_modules'), 'dir');
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { convex: '1.50.0' } }));
  await writeFile(join(functions, 'convex.config.ts'), 'import {defineApp} from "convex/server"; export default defineApp();');
  await writeFile(join(functions, 'fixtureReady.ts'), 'import {queryGeneric} from "convex/server"; export const ready = queryGeneric({args:{},handler:()=>true});');
  const cli = join(CLOUD_DIR, 'node_modules', 'convex', 'bin', 'main.js');
  const env: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous' };
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_SELF_HOSTED_URL;
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  delete env.CONVEX_DEPLOY_KEY;
  const url = `http://${LOOPBACK_HOST}:${port}`;
  const start = (name: string) => startServer(name, process.execPath, [cli, 'dev', '--local-cloud-port', String(port), '--local-site-port', String(sitePort), '--typecheck', 'disable'], {
    cwd: project, env, logFile: join(directory, name + '.log'),
  });
  let server: ManagedServer | undefined = start('convex-auth-init');
  const stopBackend = async () => {
    await server?.stop();
    server = undefined;
  };
  const stop = async () => {
    await stopBackend();
    await rm(project, { recursive: true, force: true });
  };
  try {
    await waitForUrl(url + '/version', AUTH_START_TIMEOUT_MS, () => server !== undefined && !server.exited);
    const configDeadline = Date.now() + AUTH_START_TIMEOUT_MS;
    for (;;) {
      try {
        await access(join(project, '.env.local'));
        break;
      } catch {
        if (server.exited || Date.now() >= configDeadline) throw new Error('Local auth configuration was not created');
        await sleep(AUTH_FUNCTION_POLL_MS);
      }
    }
    const client = new ConvexHttpClient(url, { logger: false });
    await waitForFunction(client, Ready, () => server !== undefined && !server.exited);
    const values = Object.values(AUTH_ENV).map(key => {
      const value = key === AUTH_ENV.siteUrl ? base
        : key === AUTH_ENV.resendKey ? VERIFY_AUTH.resendKey
        : key === AUTH_ENV.senderEmail ? VERIFY_AUTH.senderEmail
        : key === AUTH_ENV.senderName ? VERIFY_AUTH.senderName : VERIFY_AUTH.providerCredential;
      return key + '=' + JSON.stringify(value);
    });
    const environmentFile = join(project, '.env.fixture');
    await writeFile(environmentFile, values.join('\n'));
    const result = await runCommand(process.execPath, [cli, 'env', 'set', '--from-file', environmentFile], { cwd: project, env });
    if (result.code !== 0) throw new Error('Could not configure the local auth environment: ' + result.output);
    await stopBackend();
    for (const file of [...AUTH_FIXTURE_FILES, 'accountOwner.ts']) {
      await mkdir(dirname(join(functions, file)), { recursive: true });
      await copyFile(join(CLOUD_DIR, 'convex', file), join(functions, file));
    }
    const configPath = join(functions, 'convex.config.ts');
    const config = await readFile(configPath, 'utf8');
    await writeFile(configPath, config.replace("'@convex-dev/resend/convex.config.js'", "'./resend/convex.config.js'"));
    await cp(join(CLOUD_DIR, 'verify', 'auth', 'resend'), join(functions, 'resend'), { recursive: true });
    await copyFile(join(CLOUD_DIR, 'verify', 'auth', 'fixture.ts.template'), join(functions, 'fixture.ts'));
    await rm(join(functions, 'fixtureReady.ts'));
    server = start('convex-auth');
    await waitForFunction(client, IsAuthenticated, () => server !== undefined && !server.exited);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
