import {afterEach, describe, expect, it, vi} from 'vitest';
import {SealedSecret} from '@praxis/types';
import type {AutoStep, StepContext} from '@praxis/verify';
import suite, {PREVIEW_API_BYPASS, PREVIEW_API_URL, PREVIEW_WEB_URL, VERCEL_BYPASS_HEADER} from './preview-env.js';

// `.invalid` never resolves, so even a regression cannot reach a real deployment from this test.
const API = 'https://api.preview.invalid';
const WEB = 'https://web.preview.invalid';
const BYPASS = 'bypass-fixture-secret-never-printed';
const CONFIG: Record<string, string> = {[PREVIEW_API_URL]: API, [PREVIEW_WEB_URL]: WEB};

function step(id: string): AutoStep {
  const found = suite.steps.find(candidate => candidate.id === id);
  if (found?.kind !== 'auto') throw new Error(`${id} must be an auto step`);
  return found;
}

function context(): StepContext {
  const read = (name: string) => {
    const value = CONFIG[name];
    if (value === undefined) throw new Error(`undeclared ${name}`);
    return value;
  };
  return {
    config: read,
    secret: name => {
      if (name !== PREVIEW_API_BYPASS) throw new Error(`undeclared ${name}`);
      return SealedSecret.of(BYPASS);
    },
    pool: () => { throw new Error('no pools'); },
    log: () => undefined,
    attach: () => undefined,
    state: new Map(),
  };
}

function reply(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('preview-env suite', () => {
  it('passes api-health only for a production health body, sending the bypass header', async () => {
    const fetchMock = reply(Response.json({type: 'health', ok: true, mode: 'production'}));
    expect(await step('api-health').run(context())).toMatchObject({status: 'pass'});
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API}/health`);
    expect(new Headers(init?.headers).get(VERCEL_BYPASS_HEADER)).toBe(BYPASS);
  });

  it('fails api-health for local mode, a Vercel login redirect and a malformed body', async () => {
    reply(Response.json({type: 'health', ok: true, mode: 'local'}));
    expect(await step('api-health').run(context())).toMatchObject({status: 'fail', summary: expect.stringMatching(/mode is local/)});
    reply(new Response(null, {status: 302, headers: {location: 'https://vercel.com/sso'}}));
    expect(await step('api-health').run(context())).toMatchObject({status: 'fail', summary: expect.stringMatching(/got 302/)});
    reply(Response.json({mode: 'production'}));
    expect(await step('api-health').run(context())).toMatchObject({status: 'fail', summary: expect.stringMatching(/violates the protocol/)});
  });

  it('passes web-cors only when the preflight allows the web alias with credentials', async () => {
    const allowed = {'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true'};
    const fetchMock = reply(new Response(null, {status: 204, headers: allowed}));
    expect(await step('web-cors').run(context())).toMatchObject({status: 'pass'});
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('OPTIONS');
    expect(new Headers(init?.headers).has(VERCEL_BYPASS_HEADER)).toBe(false);

    reply(new Response(null, {status: 204, headers: {'access-control-allow-credentials': 'true'}}));
    expect(await step('web-cors').run(context())).toMatchObject({status: 'fail', summary: expect.stringMatching(/PRAXIS_WEB_ORIGINS/)});
    reply(new Response(null, {status: 401}));
    expect(await step('web-cors').run(context())).toMatchObject({status: 'fail', summary: expect.stringMatching(/401/)});
  });
});
