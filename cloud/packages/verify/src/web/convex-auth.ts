import { access, copyFile, cp, mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { AUTH_ENV } from '../../../../convex/authConstants.js';
import { VERIFY_AUTH, AUTH_BACKEND_PORT_OFFSET, AUTH_SITE_PORT_OFFSET, AUTH_FIXTURE_FILES, AUTH_START_TIMEOUT_MS, AUTH_FUNCTION_POLL_MS } from '../../../../verify/auth/constants.js';
import { CLOUD_DIR, LOOPBACK_HOST } from '../constants.js';
import { assertPortFree, runCommand, startServer, waitForUrl } from '../proc.js';

const SignedUp = z.object({ success: z.literal(true), browserSecret: z.string() });
const Completed = z.object({ status: z.literal('complete') });
const Signup = makeFunctionReference<'mutation'>('auth:signUpWithEmailPassword');
const Complete = makeFunctionReference<'mutation'>('auth:completeSignUpWithEmailPassword');
const LatestEmail = makeFunctionReference<'query'>('fixture:latestEmail');
const IsAuthenticated = makeFunctionReference<'query'>('auth:isAuthenticated');

/** Test-only deployment copies the current production auth source and replaces only the email-delivery component. */
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
  for (const file of AUTH_FIXTURE_FILES) await copyFile(join(CLOUD_DIR, 'convex', file), join(functions, file));
  const configPath = join(functions, 'convex.config.ts');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, config.replace("'@convex-dev/resend/convex.config.js'", "'./resend/convex.config.js'"));
  await cp(join(CLOUD_DIR, 'verify', 'auth', 'resend'), join(functions, 'resend'), { recursive: true });
  await copyFile(join(CLOUD_DIR, 'verify', 'auth', 'fixture.ts.template'), join(functions, 'fixture.ts'));
  const cli = join(CLOUD_DIR, 'node_modules', 'convex', 'bin', 'main.js');
  const env: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous' };
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_SELF_HOSTED_URL;
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  delete env.CONVEX_DEPLOY_KEY;
  const url = `http://${LOOPBACK_HOST}:${port}`;
  const server = startServer('convex-auth', process.execPath, [cli, 'dev', '--local-cloud-port', String(port), '--local-site-port', String(sitePort), '--typecheck', 'disable'], {
    cwd: project, env, logFile: join(directory, 'convex-auth.log'),
  });
  const stop = async () => {
    await server.stop();
    await rm(project, { recursive: true, force: true });
  };
  try {
    await waitForUrl(url + '/version', AUTH_START_TIMEOUT_MS, () => !server.exited);
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
    for (const key of Object.values(AUTH_ENV)) {
      const value = key === AUTH_ENV.siteUrl ? base
        : key === AUTH_ENV.resendKey ? VERIFY_AUTH.resendKey
        : key === AUTH_ENV.senderEmail ? VERIFY_AUTH.senderEmail
        : key === AUTH_ENV.senderName ? VERIFY_AUTH.senderName : VERIFY_AUTH.providerCredential;
      const result = await runCommand(process.execPath, [cli, 'env', 'set', key, value], { cwd: project, env });
      if (result.code !== 0) throw new Error(`Could not configure local auth variable ${key}: ${result.output}`);
    }
    const client = new ConvexHttpClient(url, { logger: false });
    const deadline = Date.now() + AUTH_START_TIMEOUT_MS;
    for (;;) {
      if (server.exited) throw new Error('Local auth backend exited before deployment');
      try {
        await client.query(IsAuthenticated, {});
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('Local auth functions did not deploy');
        await sleep(AUTH_FUNCTION_POLL_MS);
      }
    }
    const started = SignedUp.parse(await client.mutation(Signup, { email: VERIFY_AUTH.email, password: VERIFY_AUTH.password }));
    const text = z.string().parse(await client.query(LatestEmail, {}));
    const link = text.split('\n').find(line => line.startsWith(base));
    if (!link) throw new Error('Local signup did not produce a verification link');
    const emailCode = new URL(link).searchParams.get('code');
    Completed.parse(await client.mutation(Complete, { browserSecret: started.browserSecret, emailCode }));
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
