import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// CLI modules are standalone ESM; test the orchestration without invoking a cloud executable.
// @ts-ignore JavaScript CLI module
import { validate, required, loadEnv, safeBuildEnv } from './deploy-config.mjs';
// @ts-ignore JavaScript CLI module
import { deploy, deploymentPlan, maskCommand, stageWeb } from './deploy.mjs';
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
  expect(commands).toContain('<masked>');
});
it('dry run invokes only local builds, with no inherited credentials; preserves deploy ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const file = join(dir, 'empty');
    await writeFile(file, '');
    const runner = vi.fn().mockResolvedValue(undefined);
    await deploy(['--dry-run', '--env', file], runner);
    expect(runner.mock.calls.map((c) => c[0].name)).toEqual(['Local API build', 'Local web build']);
    for (const [, env] of runner.mock.calls)
      for (const key of required.filter((k: string) => /TOKEN|KEY|SECRET/.test(k)))
        expect(env).not.toHaveProperty(key);
    expect(safeBuildEnv('https://api.test').VITE_API_BASE_URL).toBe('https://api.test');
    const plan = deploymentPlan({});
    expect(plan.findIndex((s: any) => s.name === 'Convex deploy')).toBeLessThan(
      plan.findIndex(
        (s: any) => s.name === 'API deploy (project root cloud/apps/api, build from vercel.json)',
      ),
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
