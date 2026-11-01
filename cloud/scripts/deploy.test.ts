import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// CLI modules are standalone ESM; test the orchestration without invoking a cloud executable.
// @ts-ignore JavaScript CLI module
import { validate, required, loadEnv, safeBuildEnv } from './deploy-config.mjs';
// @ts-ignore JavaScript CLI module
import { deploy, deploymentPlan, maskCommand, stageWeb, stepEnv } from './deploy.mjs';
// @ts-ignore JavaScript CLI module
import { assertSafeUpload, listFiles, stageApi, withPrivateFile } from './deploy-stage.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
// @ts-ignore JavaScript CLI module
import { assertWorkerBypassesApi, smoke } from './smoke-remote.mjs';
it('lists every missing variable and validates formats without echoing values', () => {
  const errors = validate({});
  expect(errors).toHaveLength(required.length);
  for (const key of required) expect(errors).toContain(`${key}: missing`);
  const malformed = validate({
    CONVEX_URL: 'secret malformed value',
    PRAXIS_WEB_ORIGINS: 'https://safe.test/path',
    PRAXIS_ENCRYPTION_KEYS: 'private-value',
    VERCEL_API_PROJECT_ID: 'wrong',
  });
  expect(malformed.join('\n')).not.toContain('private-value');
  expect(malformed.join('\n')).not.toContain('secret malformed value');
  expect(malformed).toContain('CONVEX_URL: must be an HTTPS origin');
});
it('parses private env files without shell expansion, rejects duplicates, masks tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  try {
    const file = join(dir, 'env');
    await writeFile(file, "VERCEL_TOKEN='$(never-execute)'\n");
    expect(await loadEnv(file)).toEqual({ VERCEL_TOKEN: '$(never-execute)' });
    await writeFile(file, 'KEY=x\nKEY=y');
    await expect(loadEnv(file)).rejects.toThrow('Duplicate variable KEY');
  } finally {
    await rm(dir, { recursive: true });
  }
  const commands = deploymentPlan({ VERCEL_TOKEN: 'secret-token-that-must-not-leak' })
    .map(maskCommand)
    .join('\n');
  expect(commands).not.toContain('secret-token-that-must-not-leak');
  expect(commands).not.toContain('--token');
});
it('dry run invokes only local builds, with no inherited credentials; preserves deploy ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const file = join(dir, 'empty');
    await writeFile(file, '');
    const runner = vi.fn().mockResolvedValue(undefined);
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist/index.html'), '<div id="root"></div>');
    await deploy(['--dry-run', '--env', file], runner, {
      deployDir: join(dir, 'deploy'),
      webDist: join(dir, 'dist'),
    });
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/API upload: \d+ files, no secret files/);
    expect(printed).toMatch(/Web upload: \d+ files/);
    const uploaded = await listFiles(join(dir, 'deploy/api'));
    expect(uploaded).toContain('cloud/apps/api/vercel.json');
    expect(
      uploaded.filter((f: string) => /PraxisChat|\.env(?!\.example)|node_modules|\.test\./.test(f)),
    ).toEqual([]);
    expect(runner.mock.calls.map((c) => c[0].name)).toEqual(['Local API build', 'Local web build']);
    for (const [, env] of runner.mock.calls)
      for (const key of required.filter((k: string) => /TOKEN|KEY|SECRET/.test(k)))
        expect(env).not.toHaveProperty(key);
    expect(safeBuildEnv('https://api.test').VITE_API_BASE_URL).toBe('https://api.test');
    const plan = deploymentPlan({});
    expect(plan.findIndex((s: any) => s.name === 'Convex deploy')).toBeLessThan(
      plan.findIndex((s: any) => s.name.startsWith('API deploy')),
    );
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true });
  }
});
it('executes the service worker cache boundary and rejects API interception', () => {
  const good =
    "self.addEventListener('fetch', e=>{if(new URL(e.request.url).pathname.startsWith('/v1')||new URL(e.request.url).pathname.startsWith('/health'))return;e.respondWith(null);})";
  expect(() => assertWorkerBypassesApi(good, 'https://web.test')).not.toThrow();
  expect(() =>
    assertWorkerBypassesApi(
      "self.addEventListener('fetch',e=>e.respondWith(null))",
      'https://web.test',
    ),
  ).toThrow();
});
it('hosted dry smoke makes no mutating requests and never creates an account', async () => {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    calls.push(init?.method ?? 'GET');
    if (String(url).endsWith('/health')) return Response.json({ ok: true, mode: 'production' });
    if (String(url).endsWith('/sw.js')) return new Response("self.addEventListener('fetch',e=>{})");
    return new Response('<div id="root"></div>');
  });
  const result = await smoke(['https://api.test', 'https://web.test', '--dry-run'], fetcher);
  expect(calls).toEqual(['GET', 'GET', 'GET']);
  expect(result.skipped).toHaveLength(1);
});
it('cleans up a hosted test account even when upload smoke fails (in-memory HTTP fixtures only)', async () => {
  let deleted = false;
  const requests: string[] = [];
  const fixture = async (input: any, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    requests.push((init.method ?? 'GET') + ' ' + path);
    if (path === '/health') return Response.json({ ok: true, mode: 'production' });
    if (path === '/sw.js') return new Response("self.addEventListener('fetch',e=>{})");
    if (path === '/') return new Response('<div id="root"></div>');
    if (path === '/v1/auth/sign-up' || path === '/v1/auth/sign-in')
      return Response.json({ bearerToken: 'test-only-session' });
    if (path === '/v1/bootstrap')
      return deleted
        ? Response.json({}, { status: 401 })
        : Response.json({ user: { id: 'fixture-user' } });
    if (path === '/v1/chats') return Response.json({ id: 'fixture-chat' });
    if (path === '/v1/uploads') return Response.json({}, { status: 500 });
    if (path === '/v1/account') {
      deleted = true;
      return Response.json({ type: 'account.deleted' });
    }
    return Response.json({});
  };
  await expect(smoke(['https://api.test', 'https://web.test'], fixture)).rejects.toThrow(
    'POST /v1/uploads: HTTP 500',
  );
  expect(requests).toContain('DELETE /v1/account');
  expect(deleted).toBe(true);
});

it('stages deterministic Vercel static output without stale assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-stage-'));
  try {
    const dist = join(dir, 'dist'),
      stage = join(dir, 'stage');
    await mkdir(dist);
    await writeFile(join(dist, 'old.js'), 'old');
    await stageWeb({ VERCEL_ORG_ID: 'team_test', VERCEL_WEB_PROJECT_ID: 'prj_test' }, stage, dist);
    await rm(join(dist, 'old.js'));
    await writeFile(join(dist, 'index.html'), '<div id="root"></div>');
    await stageWeb({ VERCEL_ORG_ID: 'team_test', VERCEL_WEB_PROJECT_ID: 'prj_test' }, stage, dist);
    expect(await readdir(join(stage, '.vercel/output/static'))).toEqual(['index.html']);
    expect(
      JSON.parse(await readFile(join(stage, '.vercel/output/config.json'), 'utf8')).version,
    ).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SECRETS: Record<string, string> = {
  VERCEL_TOKEN: 'vercel-secret-0123456789abcdef',
  VERCEL_ORG_ID: 'team_test',
  VERCEL_API_PROJECT_ID: 'prj_api',
  VERCEL_WEB_PROJECT_ID: 'prj_web',
  CONVEX_DEPLOY_KEY: 'prod:convex-secret-0123456789',
  PRAXIS_CONVEX_SERVER_TOKEN: 'server-secret-0123456789abcdef0123456789',
  UPSTASH_REDIS_REST_TOKEN: 'upstash-secret-0123456789',
  QSTASH_TOKEN: 'qstash-secret-0123456789',
  QSTASH_CURRENT_SIGNING_KEY: 'sig-current-0123456789',
  QSTASH_NEXT_SIGNING_KEY: 'sig-next-0123456789abc',
  PRAXIS_ENCRYPTION_KEYS: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  BETTER_AUTH_SECRET: 'auth-secret-0123456789abcdef0123456789',
  GROQ_API_KEY: 'gsk_groq-secret-0123456789',
};
it('never puts a secret in argv; each credential reaches only the tool that needs it; CLIs are pinned', () => {
  const plan = deploymentPlan(SECRETS);
  const argv = plan.map((s: any) => s.args.join(' ') + ' ' + maskCommand(s)).join('\n');
  for (const [key, value] of Object.entries(SECRETS))
    if (!/_ID$/.test(key)) expect(argv, key).not.toContain(value);
  expect(argv).not.toContain('--token');
  for (const step of plan) {
    const env = stepEnv(step, SECRETS, 'https://api.test');
    expect(Boolean(env.VERCEL_TOKEN), step.name).toBe(step.tool === 'vercel');
    expect(Boolean(env.CONVEX_DEPLOY_KEY), step.name).toBe(step.tool === 'convex');
    for (const key of [
      'PRAXIS_CONVEX_SERVER_TOKEN',
      'BETTER_AUTH_SECRET',
      'UPSTASH_REDIS_REST_TOKEN',
    ])
      expect(env, step.name).not.toHaveProperty(key);
    if (step.tool === 'vercel')
      expect(step.args.slice(0, 3)).toEqual([
        'npx',
        '--yes',
        expect.stringMatching(/^vercel@\d+\.\d+\.\d+$/),
      ]);
    if (step.tool === 'convex')
      expect(step.args.slice(0, 3)).toEqual(['npx', '--no-install', 'convex']);
  }
});
it('stages the API from an allowlist and rejects secret files, the iOS app and leaked values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-api-'));
  try {
    const src = join(dir, 'repo/cloud');
    const put = async (path: string, text = 'x') => {
      await mkdir(join(src, path, '..'), { recursive: true });
      await writeFile(join(src, path), text);
    };
    for (const f of [
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      'apps/web/package.json',
      'apps/api/vercel.json',
      'apps/api/src/app.ts',
      'packages/protocol/src/index.ts',
    ])
      await put(f);
    for (const f of [
      '.env.deploy',
      '.env',
      'apps/api/.env.production',
      'apps/api/src/app.test.ts',
      'apps/api/node_modules/x/index.js',
      'apps/web/src/secret.ts',
      'convex/schema.ts',
    ])
      await put(f, SECRETS.VERCEL_TOKEN);
    await mkdir(join(dir, 'repo/PraxisChat'), { recursive: true });
    await writeFile(join(dir, 'repo/PraxisChat/App.swift'), 'ios');
    const stage = await stageApi(join(dir, 'stage'), src);
    const files = await listFiles(stage);
    expect(files).toEqual([
      '.vercelignore',
      'cloud/apps/api/src/app.ts',
      'cloud/apps/api/vercel.json',
      'cloud/apps/web/package.json',
      'cloud/package-lock.json',
      'cloud/package.json',
      'cloud/packages/protocol/src/index.ts',
      'cloud/tsconfig.base.json',
    ]);
    await expect(assertSafeUpload(stage, files, Object.values(SECRETS))).resolves.toBeUndefined();
    for (const bad of [
      'cloud/.env.deploy',
      'PraxisChat/App.swift',
      'cloud/apps/api/.env',
      'x/key.p8',
    ])
      await expect(assertSafeUpload(stage, [...files, bad])).rejects.toThrow('forbidden');
    await writeFile(
      join(stage, 'cloud/apps/api/src/app.ts'),
      `const t = '${SECRETS.QSTASH_TOKEN}'`,
    );
    await expect(assertSafeUpload(stage, files, Object.values(SECRETS))).rejects.toThrow(
      'cloud/apps/api/src/app.ts contains a deployment secret',
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
it('removes the private Convex token file on success, failure and SIGTERM', async () => {
  let seen = '';
  await withPrivateFile('secret', async (file: string) => {
    seen = file;
    expect(await readFile(file, 'utf8')).toBe('secret');
  });
  expect(existsSync(seen)).toBe(false);
  await expect(
    withPrivateFile('secret', async (file: string) => {
      seen = file;
      throw Error('cli failed');
    }),
  ).rejects.toThrow('cli failed');
  expect(existsSync(seen)).toBe(false);
  const module = new URL('./deploy-stage.mjs', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `const {withPrivateFile}=await import(${JSON.stringify(module)});await withPrivateFile('secret',f=>{console.log(f);return new Promise(()=>setInterval(()=>{},1000));});`,
  ]);
  const path = await new Promise<string>((resolve) =>
    child.stdout.once('data', (d) => resolve(String(d).trim())),
  );
  expect(existsSync(path)).toBe(true);
  const exited = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  child.kill('SIGTERM');
  expect(await exited).toBe('SIGTERM');
  expect(existsSync(path)).toBe(false);
});
function smokeFixture(options: { signInFailures?: number; deleteStatus?: number }) {
  let deleted = false,
    signIns = 0;
  const deletes: string[] = [];
  const fetcher = async (input: any, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === '/health') return Response.json({ ok: true, mode: 'production' });
    if (path === '/sw.js') return new Response("self.addEventListener('fetch',e=>{})");
    if (path === '/') return new Response('<div id="root"></div>');
    if (path === '/v1/auth/sign-up') return Response.json({ bearerToken: 'signup-token' });
    if (path === '/v1/auth/sign-in')
      return ++signIns <= (options.signInFailures ?? 0)
        ? Response.json({}, { status: 500 })
        : Response.json({ bearerToken: `fresh-${signIns}` });
    if (path === '/v1/account') {
      deletes.push(init.headers.authorization);
      if (options.deleteStatus) return Response.json({}, { status: options.deleteStatus });
      deleted = true;
      return Response.json({ type: 'account.deleted' });
    }
    if (path === '/v1/bootstrap') return Response.json({}, { status: 401 });
    return Response.json({});
  };
  return { fetcher, deletes, deleted: () => deleted };
}
it('smoke cleanup re-authenticates after a failed sign-in and reports the original failure', async () => {
  const f = smokeFixture({ signInFailures: 1 });
  await expect(smoke(['https://api.test', 'https://web.test'], f.fetcher)).rejects.toThrow(
    /^POST \/v1\/auth\/sign-in: HTTP 500$/,
  );
  expect(f.deletes).toEqual(['Bearer fresh-2']);
  expect(f.deleted()).toBe(true);
});
it('smoke keeps the original failure when cleanup also fails', async () => {
  const f = smokeFixture({ signInFailures: 1, deleteStatus: 500 });
  await expect(smoke(['https://api.test', 'https://web.test'], f.fetcher)).rejects.toThrow(
    /^POST \/v1\/auth\/sign-in: HTTP 500 \(cleanup also failed: DELETE \/v1\/account: HTTP 500;/,
  );
});
