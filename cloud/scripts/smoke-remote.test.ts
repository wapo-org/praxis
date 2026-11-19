import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore JavaScript CLI module
import { REMOVED_AUTH_ROUTES, smoke } from './smoke-remote.mjs';
// @ts-ignore JavaScript CLI module
import { SMOKE_FIXTURE_KEYS } from './smoke-fixture.mjs';
import { createSmokeApp } from '../apps/api/src/smoke.js';
import { API, BINDINGS, CONVEX, EMAIL, type Fetcher, LEAK, PASSWORD, REFRESH, SIGN_IN, SIGN_OUT, STORAGE, WEB, hostedFixture, shell } from './smoke-hosted-mock.js';

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
      // Revocation and its check carry only the refresh token, never an access credential.
      { path: SIGN_OUT, args: { refreshToken: 'fixture-refresh-1' }, auth: null },
      { path: REFRESH, args: { refreshToken: 'fixture-refresh-1' }, auth: null },
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
    expect(f.liveSessions()).toEqual([]);
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
    expect(f.requests).toEqual([]);
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
    expect(f.requests).toEqual([]);
  });

  it.each([
    'http://api.test',
    'https://smoke-userinfo-secret@api.test',
    'https://user:smoke-userinfo-secret@api.test',
    'https://api.test/path',
    'https://api.test/?query=smoke-query-secret',
    'https://api.test?',
    'https://api.test/#smoke-fragment',
    'https://api.test#',
    'not a url smoke-raw-secret',
  ])('rejects bound origin %s before any request, without echoing it', async (malformed) => {
    for (const key of ['SMOKE_API_ORIGIN', 'SMOKE_CONVEX_URL']) {
      const f = hostedFixture();
      const failure = smoke([API, WEB, '--env', await envFile({ ...BINDINGS, [key]: malformed })], f.fetcher);
      await expect(failure).rejects.toThrow(new RegExp(`^${key} must be a bare HTTPS origin$`));
      await failure.catch((error: Error) => {
        expect(error.cause).toBeUndefined();
        expect(error.message).not.toMatch(/smoke-|user:|\?|#/);
      });
      expect(f.requests).toEqual([]);
      expect(f.convexCalls).toEqual([]);
    }
  });

  it('accepts a trailing slash on bound origins and calls Convex at the bare origin', async () => {
    const f = hostedFixture();
    const bindings = { ...BINDINGS, SMOKE_API_ORIGIN: `${API}/`, SMOKE_CONVEX_URL: `${CONVEX}/` };
    await smoke([API, WEB, '--env', await envFile(bindings)], f.fetcher);
    expect(f.calls()).toEqual([SIGN_IN, SIGN_OUT, REFRESH]);
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
    expect(f.calls()).toEqual([SIGN_IN, SIGN_OUT, REFRESH]);
    expect(f.liveSessions()).toEqual([]);
    expect(writes(f.requests)).toEqual([]);
  });

  it('removes the smoke chat and revokes the session when upload fails', async () => {
    const f = hostedFixture({ uploadStatus: 500 });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher))
      .rejects.toThrow(/^POST \/v1\/uploads: HTTP 500$/);
    expect(writes(f.requests)).toEqual(['POST /v1/chats', 'POST /v1/uploads', 'DELETE /v1/chats/smoke-chat']);
    expect(f.liveSessions()).toEqual([]);
  });

  it('keeps the original failure and still revokes the session when cleanup also fails', async () => {
    const f = hostedFixture({ uploadStatus: 500, chatDeleteStatus: 500 });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher)).rejects.toThrow(
      /^POST \/v1\/uploads: HTTP 500 \(cleanup also failed: DELETE \/v1\/chats\/smoke-chat: HTTP 500; remove smoke chat smoke-chat/,
    );
    expect(f.calls()).toEqual([SIGN_IN, SIGN_OUT, REFRESH]);
    expect(f.liveSessions()).toEqual([]);
  });

  it('re-signs in once when the access token expires during cleanup, without re-deleting', async () => {
    const f = hostedFixture({ expireFirstDelete: true });
    await smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher);
    expect(writes(f.requests).filter((request) => request.startsWith('DELETE'))).toEqual([
      'DELETE /v1/uploads/smoke-attachment',
      'DELETE /v1/uploads/smoke-attachment',
      'DELETE /v1/chats/smoke-chat',
    ]);
    expect(f.calls()).toEqual([SIGN_IN, SIGN_IN, SIGN_OUT, REFRESH, SIGN_OUT, REFRESH]);
    expect(f.liveSessions()).toEqual([]);
  });

  it.each([
    ['signOutFail', 'revocation request failed', ['fixture-refresh-1']],
    ['checkFail', 'revocation check failed', []],
    ['signOutIgnored', 'session still live after sign-out', ['fixture-refresh-1-rotated']],
  ] as const)('a %s on the first of two sessions still revokes the second', async (failure, problem, stillLive) => {
    const f = hostedFixture({ expireFirstDelete: true, [failure]: [1] });
    const run = smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher);
    await expect(run).rejects.toThrow(
      `Fixture sign-out incomplete (session 1: ${problem}); revoke those sessions manually`,
    );
    await run.catch((error: Error) => {
      for (const secret of [LEAK, PASSWORD, 'fixture-access', 'fixture-refresh']) expect(error.message).not.toContain(secret);
    });
    const revocations = f.convexCalls.filter((call) => call.path === SIGN_OUT);
    expect(revocations.map((call) => call.args.refreshToken)).toEqual(['fixture-refresh-1', 'fixture-refresh-2']);
    expect(revocations.every((call) => call.auth === null)).toBe(true);
    expect(f.liveSessions()).toEqual(stillLive);
  });

  it('reports data-removal and revocation failures together after the original error', async () => {
    const f = hostedFixture({ uploadStatus: 500, chatDeleteStatus: 500, signOutFail: [1] });
    await expect(smoke([API, WEB, '--env', await envFile(BINDINGS)], f.fetcher)).rejects.toThrow(
      'POST /v1/uploads: HTTP 500 (cleanup also failed: DELETE /v1/chats/smoke-chat: HTTP 500; ' +
        'Fixture sign-out incomplete (session 1: revocation request failed); revoke those sessions manually; ' +
        'remove smoke chat smoke-chat from the fixture and revoke its sessions manually)',
    );
  });

  it('reports a failed sign-in request by stage, never the server text', async () => {
    const f = hostedFixture();
    const fetcher: Fetcher = async (input, init) =>
      new URL(String(input)).origin === CONVEX ? new Response(LEAK, { status: 500 }) : f.fetcher(input, init);
    const run = smoke([API, WEB, '--env', await envFile(BINDINGS)], fetcher);
    await expect(run).rejects.toThrow(/^Fixture sign-in request failed$/);
    expect(writes(f.requests)).toEqual([]);
  });

  it('--with-llm fails explicitly without a pre-connected fixture key and never writes credentials', async () => {
    const f = hostedFixture();
    await expect(smoke([API, WEB, '--with-llm', '--env', await envFile(BINDINGS)], f.fetcher))
      .rejects.toThrow('--with-llm needs a model key already connected on the fixture account');
    expectNoLegacyOrAccountWrites(f.requests);
    expect(writes(f.requests)).toContain('DELETE /v1/chats/smoke-chat');
    expect(f.liveSessions()).toEqual([]);
  });

  it('--with-llm runs a real-model turn on the fixture key and checks SSE resume', async () => {
    const f = hostedFixture({ modelKey: true });
    const bindings = { ...BINDINGS, SMOKE_OPENROUTER_MODEL: 'openrouter/smoke-model' };
    const result = await smoke([API, WEB, '--with-llm', '--env', await envFile(bindings)], f.fetcher);
    expect(result.checks).toContain('SSE disconnect/resume and finished snapshot');
    expect(writes(f.requests)).toContain('POST /v1/runs');
    expectNoLegacyOrAccountWrites(f.requests);
    expect(f.liveSessions()).toEqual([]);
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
