import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore JavaScript CLI module
import { REMOVED_AUTH_ROUTES, smoke } from './smoke-remote.mjs';
// @ts-ignore JavaScript CLI module
import { SMOKE_FIXTURE_KEYS } from './smoke-fixture.mjs';
import { createSmokeApp } from '../apps/api/src/smoke.js';

const API = 'https://api.test';
const WEB = 'https://web.test';
const CONVEX = 'https://fixture-smoke.convex.cloud';
const STORAGE = 'https://storage.test';
const FIXTURE_USER = 'fixture-user';
const EMAIL = 'smoke-fixture@example.test';
const PASSWORD = 'fixture-password-never-printed';
const SIGN_IN = 'auth:signInWithEmailPassword';
const SIGN_OUT = 'auth:signOut';
const IS_AUTHENTICATED = 'auth:isAuthenticated';
const BINDINGS: Record<string, string> = {
  SMOKE_API_ORIGIN: API,
  SMOKE_CONVEX_URL: CONVEX,
  SMOKE_FIXTURE_EMAIL: EMAIL,
  SMOKE_FIXTURE_PASSWORD: PASSWORD,
  SMOKE_FIXTURE_USER_ID: FIXTURE_USER,
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ConvexCall = { path: string; args: Record<string, unknown>; auth: string | null };
type SignInReply = { status: 'complete'; userId?: string } | { status: 'error'; error: string };
type HostedOptions = {
  signIn?: SignInReply;
  uploadStatus?: number;
  chatDeleteStatus?: number;
  expireFirstDelete?: boolean;
  modelKey?: boolean;
};

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'smoke-fixture-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true });
});

// Always pass --env so a developer's real .env.deploy is never read by a test.
async function envFile(bindings: Record<string, string>) {
  const file = join(dir, 'smoke.env');
  await writeFile(file, Object.entries(bindings).map(([key, value]) => `${key}=${value}`).join('\n'));
  return file;
}

function shell(path: string) {
  if (path === '/sw.js') return new Response("self.addEventListener('fetch',e=>{})");
  return new Response('<div id="root"></div>');
}

/** In-memory API plus the official Convex HTTP function contract; nothing leaves the process. */
function hostedFixture(options: HostedOptions = {}) {
  const requests: string[] = [];
  const convexCalls: ConvexCall[] = [];
  const active = new Set<string>();
  let signIns = 0;
  let deletes = 0;

  function convex(url: URL, init?: RequestInit) {
    const body = JSON.parse(String(init?.body)) as { path: string; args: [Record<string, unknown>] };
    const auth = new Headers(init?.headers).get('authorization');
    convexCalls.push({ path: body.path, args: body.args[0], auth });
    const reply = (value: unknown) => Response.json({ status: 'success', value, logLines: [] });
    if (url.pathname === '/api/mutation' && body.path === SIGN_IN) {
      const signIn = options.signIn ?? { status: 'complete' };
      if (signIn.status === 'error') return reply({ status: 'error', userError: { error: signIn.error } });
      signIns++;
      const tokens = {
        accessToken: `fixture-access-${signIns}`,
        refreshToken: `fixture-refresh-${signIns}`,
        refreshTokenExpiresAt: 1,
        userId: signIn.userId ?? FIXTURE_USER,
      };
      active.add(tokens.accessToken);
      return reply({ status: 'complete', tokens });
    }
    if (url.pathname === '/api/mutation' && body.path === SIGN_OUT) {
      active.delete(String(auth).replace('Bearer ', ''));
      return reply(null);
    }
    if (url.pathname === '/api/query' && body.path === IS_AUTHENTICATED) {
      return reply(active.has(String(auth).replace('Bearer ', '')));
    }
    return Response.json({ status: 'error', errorMessage: 'unexpected function' }, { status: 560 });
  }

  function api(url: URL, method: string, init?: RequestInit) {
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /health') return Response.json({ ok: true, mode: 'production' });
    if (!active.has(token)) return Response.json({}, { status: 401 });
    if (route === 'GET /v1/bootstrap') {
      return Response.json({ user: { id: FIXTURE_USER }, ...(options.modelKey ? { modelKey: { maskedKey: '••••' } } : {}) });
    }
    if (route === 'POST /v1/chats') return Response.json({ id: 'smoke-chat' });
    if (route === 'POST /v1/uploads') {
      return Response.json({ uploadUrl: `${STORAGE}/put`, method: 'PUT' }, { status: options.uploadStatus ?? 200 });
    }
    if (route === 'POST /v1/uploads/complete') return Response.json({ id: 'smoke-attachment' });
    if (route === 'GET /v1/uploads/smoke-attachment/download') return new Response('Praxis smoke upload\n');
    if (method === 'DELETE' && options.expireFirstDelete && deletes++ === 0) {
      active.delete(token);
      return Response.json({}, { status: 401 });
    }
    if (route === 'DELETE /v1/uploads/smoke-attachment') return Response.json({ type: 'ok' });
    if (route === 'DELETE /v1/chats/smoke-chat') {
      return Response.json({ type: 'ok' }, { status: options.chatDeleteStatus ?? 200 });
    }
    if (route === 'POST /v1/runs') return Response.json({ id: 'smoke-run' });
    if (route === 'GET /v1/runs/smoke-run/events') {
      const resumed = new Headers(init?.headers).get('last-event-id') === '1';
      return new Response(resumed ? 'id: 2\ndata: {}\n\n' : 'id: 1\ndata: {}\n\n');
    }
    if (route === 'GET /v1/runs/smoke-run/snapshot') return Response.json({ run: { status: 'completed' } });
    return Response.json({}, { status: 404 });
  }

  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.origin === CONVEX) return convex(url, init);
    requests.push(`${method} ${url.origin === API ? url.pathname : url.href}`);
    if (url.origin === WEB) return shell(url.pathname);
    if (url.origin === STORAGE) return Response.json({ storageId: 'smoke-storage' });
    return api(url, method, init);
  };
  const calls = () => convexCalls.map((call) => call.path);
  return { fetcher, requests, convexCalls, calls, active };
}

const writes = (requests: string[]) => requests.filter((request) => !request.startsWith('GET '));

function expectNoLegacyOrAccountWrites(requests: string[]) {
  for (const request of requests) {
    expect(request).not.toMatch(/\/v1\/auth\/|\/v1\/account|\/v1\/model-key/);
  }
}

describe('hosted smoke with a consenting Convex Auth fixture', () => {
  it('dry run reads only and never touches the fixture or Convex Auth', async () => {
    const f = hostedFixture();
    const result = await smoke([API, WEB, '--dry-run', '--env', await envFile(BINDINGS)], f.fetcher);
    expect(f.requests).toEqual(['GET /health', `GET ${WEB}/`, `GET ${WEB}/sw.js`]);
    expect(f.convexCalls).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it('signs in through Convex Auth and leaves no smoke data or live session behind', async () => {
    const f = hostedFixture();
    const result = await smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher);
    expect(f.convexCalls).toEqual([
      { path: SIGN_IN, args: { email: EMAIL, password: PASSWORD }, auth: null },
      { path: SIGN_OUT, args: { refreshToken: 'fixture-refresh-1' }, auth: 'Bearer fixture-access-1' },
      { path: IS_AUTHENTICATED, args: {}, auth: 'Bearer fixture-access-1' },
    ]);
    expect(writes(f.requests)).toEqual([
      'POST /v1/chats',
      'POST /v1/uploads',
      `PUT ${STORAGE}/put`,
      'POST /v1/uploads/complete',
      'DELETE /v1/uploads/smoke-attachment',
      'DELETE /v1/chats/smoke-chat',
    ]);
    expectNoLegacyOrAccountWrites(f.requests);
    expect(f.active.size).toBe(0);
    expect(result.checks).toEqual(expect.arrayContaining([
      'Convex Auth fixture sign-in',
      'authenticated bootstrap',
      'upload/download round trip',
      'fixture data cleanup and session revocation',
    ]));
    expect(result.skipped.join('\n')).toMatch(/account deletion not exercised[\s\S]*LLM and SSE checks skipped/);
    const printed = JSON.stringify(result);
    for (const secret of [PASSWORD, EMAIL, 'fixture-access-1', 'fixture-refresh-1']) {
      expect(printed).not.toContain(secret);
    }
  });

  it.each(SMOKE_FIXTURE_KEYS as string[])('fails explicitly before any write when %s is missing', async (key) => {
    const f = hostedFixture();
    const { [key]: _missing, ...partial } = BINDINGS;
    const failure = smoke([API, WEB, '--env', await envFile(partial)], f.fetcher);
    await expect(failure).rejects.toThrow(`missing private bindings: ${key}`);
    await failure.catch((error: Error) => {
      for (const value of Object.values(BINDINGS)) expect(error.message).not.toContain(value);
    });
    expect(writes(f.requests)).toEqual([]);
    expect(f.convexCalls).toEqual([]);
  });

  it('fails when no private env file exists instead of reporting success', async () => {
    const f = hostedFixture();
    await expect(smoke([API, WEB, '--env', join(dir, 'absent.env')], f.fetcher))
      .rejects.toThrow(`missing private bindings: ${SMOKE_FIXTURE_KEYS.join(', ')}`);
    expect(f.convexCalls).toEqual([]);
  });

  it('refuses fixture bindings that name another deployment', async () => {
    const f = hostedFixture();
    const bindings = { ...BINDINGS, SMOKE_API_ORIGIN: 'https://other-api.test' };
    await expect(smoke([API, WEB, '--env', await envFile(bindings)], f.fetcher))
      .rejects.toThrow('SMOKE_API_ORIGIN does not name this API');
    expect(f.convexCalls).toEqual([]);
    expect(writes(f.requests)).toEqual([]);
  });

  it.each(['INVALID_CREDENTIALS', 'RATE_LIMITED', 'USER_NOT_FOUND'])(
    'reports a denied fixture sign-in (%s) without writing or echoing credentials',
    async (error) => {
      const f = hostedFixture({ signIn: { status: 'error', error } });
      const failure = smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher);
      await expect(failure).rejects.toThrow(`Fixture sign-in denied: ${error}`);
      await failure.catch((thrown: Error) => expect(thrown.message).not.toContain(PASSWORD));
      expect(f.calls()).toEqual([SIGN_IN]);
      expect(writes(f.requests)).toEqual([]);
    },
  );

  it('signs out an unexpected identity before any data write', async () => {
    const f = hostedFixture({ signIn: { status: 'complete', userId: 'someone-else' } });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher))
      .rejects.toThrow('Fixture sign-in resolved to an unexpected user; signed out before writing data');
    expect(f.calls()).toEqual([SIGN_IN, SIGN_OUT, IS_AUTHENTICATED]);
    expect(f.active.size).toBe(0);
    expect(writes(f.requests)).toEqual([]);
  });

  it('removes the smoke chat and revokes the session when upload fails', async () => {
    const f = hostedFixture({ uploadStatus: 500 });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher))
      .rejects.toThrow(/^POST \/v1\/uploads: HTTP 500$/);
    expect(writes(f.requests)).toEqual(['POST /v1/chats', 'POST /v1/uploads', 'DELETE /v1/chats/smoke-chat']);
    expect(f.active.size).toBe(0);
  });

  it('keeps the original failure and still revokes the session when cleanup also fails', async () => {
    const f = hostedFixture({ uploadStatus: 500, chatDeleteStatus: 500 });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher)).rejects.toThrow(
      /^POST \/v1\/uploads: HTTP 500 \(cleanup also failed: DELETE \/v1\/chats\/smoke-chat: HTTP 500; remove smoke chat smoke-chat/,
    );
    expect(f.calls()).toEqual([SIGN_IN, SIGN_OUT, IS_AUTHENTICATED]);
    expect(f.active.size).toBe(0);
  });

  it('re-signs in once when the access token expires during cleanup, without re-deleting', async () => {
    const f = hostedFixture({ expireFirstDelete: true });
    await smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher);
    expect(writes(f.requests).filter((request) => request.startsWith('DELETE'))).toEqual([
      'DELETE /v1/uploads/smoke-attachment',
      'DELETE /v1/uploads/smoke-attachment',
      'DELETE /v1/chats/smoke-chat',
    ]);
    expect(f.calls()).toEqual([SIGN_IN, SIGN_IN, SIGN_OUT, IS_AUTHENTICATED, SIGN_OUT, IS_AUTHENTICATED]);
    expect(f.active.size).toBe(0);
  });

  it('--with-llm fails explicitly without a pre-connected fixture key and never writes credentials', async () => {
    const f = hostedFixture();
    await expect(smoke([API, WEB, '--with-llm', '--env', await envFile(BINDINGS)], f.fetcher))
      .rejects.toThrow('--with-llm needs a model key already connected on the fixture account');
    expectNoLegacyOrAccountWrites(f.requests);
    expect(writes(f.requests)).toContain('DELETE /v1/chats/smoke-chat');
    expect(f.active.size).toBe(0);
  });

  it('--with-llm runs a real-model turn on the fixture key and checks SSE resume', async () => {
    const f = hostedFixture({ modelKey: true });
    const bindings = { ...BINDINGS, SMOKE_OPENROUTER_MODEL: 'openrouter/smoke-model' };
    const result = await smoke([API, WEB, '--with-llm', '--env', await envFile(bindings)], f.fetcher);
    expect(result.checks).toContain('SSE disconnect/resume and finished snapshot');
    expect(writes(f.requests)).toContain('POST /v1/runs');
    expectNoLegacyOrAccountWrites(f.requests);
    expect(f.active.size).toBe(0);
  });
});

describe('local smoke against the local API bundle', () => {
  it('proves the legacy API email auth routes are gone and completes the disposable-session flow', async () => {
    const app = createSmokeApp();
    // In-process only: upload tickets name the bundle's PORT origin, but no socket is ever bound.
    const local = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
    const web = 'http://127.0.0.1:5196';
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === web) return shell(url.pathname);
      return app.fetch(new Request(url, init));
    };
    for (const path of REMOVED_AUTH_ROUTES as string[]) {
      // No longer public: unauthenticated callers are refused before routing.
      expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(401);
    }
    const result = await smoke([local, web, '--dry-run'], fetcher);
    expect(result.checks).toEqual(expect.arrayContaining([
      'legacy API email auth routes removed',
      'local session/sign-out/revocation',
      'SSE disconnect/resume and finished snapshot',
      'account/data cleanup and session revocation',
    ]));
  }, 30000);
});
