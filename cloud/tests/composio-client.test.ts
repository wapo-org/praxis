import {parseTenantId} from '@praxis/types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_ERROR_CODES,
  ComposioError,
  composioFor,
} from '../convex/composio/client.js';

const API_KEY = 'ck_test_secret_value_123';
const TENANT_ID = parseTenantId(`tn_${'ab'.repeat(32)}`);
const ENV = {COMPOSIO_API_KEY: API_KEY, COMPOSIO_AUTH_CONFIG_GITHUB: 'ac_github'};
const LINK_RESPONSE = {
  link_token: 'lt_1',
  redirect_url: 'https://connect.composio.dev/link/lt_1',
  expires_at: '2026-11-19T12:10:00.000Z',
  connected_account_id: 'ca_1',
};

function stubFetch(status: number, body: unknown) {
  const fake = vi.fn(async (_url: string, _init: RequestInit) => {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  });
  vi.stubGlobal('fetch', fake);
  return fake;
}

async function caught(promise: Promise<unknown>): Promise<ComposioError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  if (!(error instanceof ComposioError)) throw new Error('expected a ComposioError');
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composioFor', () => {
  it('posts the tenant id and auth config to the link endpoint and parses the reply', async () => {
    const fake = stubFetch(201, LINK_RESPONSE);
    const link = await composioFor(ENV).createConnectLink({
      tenantId: TENANT_ID,
      toolkit: 'github',
      callbackUrl: 'https://app.example/connections/callback',
    });

    expect(link).toEqual({
      redirectUrl: LINK_RESPONSE.redirect_url,
      connectedAccountId: 'ca_1',
      expiresAt: Date.parse(LINK_RESPONSE.expires_at),
    });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe(`${COMPOSIO_API_BASE_URL}/connected_accounts/link`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({'x-api-key': API_KEY});
    expect(JSON.parse(String(init.body))).toEqual({
      auth_config_id: 'ac_github',
      user_id: TENANT_ID,
      callback_url: 'https://app.example/connections/callback',
    });
  });

  it('deletes and revokes upstream, treating an already-gone account as revoked', async () => {
    const fake = stubFetch(200, {success: true});
    await composioFor(ENV).revokeConnection('ca_1');
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe(`${COMPOSIO_API_BASE_URL}/connected_accounts/ca_1?revoke_on_delete=true`);
    expect(init.method).toBe('DELETE');

    stubFetch(404, {error: {message: 'not found'}});
    await expect(composioFor(ENV).revokeConnection('ca_1')).resolves.toBeUndefined();
  });

  it.each([401, 500])('maps HTTP %i to a coded error without the response body', async (status) => {
    stubFetch(status, {error: {message: `echo ${API_KEY}`}});
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: 'github', callbackUrl: 'https://a.example'}),
    );
    expect(error.code).toBe(COMPOSIO_ERROR_CODES.http);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain('echo');
  });

  it('rejects a malformed success body', async () => {
    stubFetch(201, {redirect_url: 'not a url'});
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: 'github', callbackUrl: 'https://a.example'}),
    );
    expect(error.code).toBe(COMPOSIO_ERROR_CODES.invalidResponse);
  });

  it('rejects an insecure redirect from the provider', async () => {
    stubFetch(201, {...LINK_RESPONSE, redirect_url: 'javascript:alert(1)'});
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: 'github', callbackUrl: 'https://a.example'}),
    );
    expect(error.code).toBe(COMPOSIO_ERROR_CODES.invalidResponse);
  });

  it('fails closed without an API key', () => {
    expect(() => composioFor({})).toThrow(/COMPOSIO_API_KEY is not set/);
  });

  it('fails closed without an auth config for the toolkit, naming the env var', async () => {
    const fake = stubFetch(201, LINK_RESPONSE);
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: 'slack', callbackUrl: 'https://a.example'}),
    );
    expect(error.code).toBe(COMPOSIO_ERROR_CODES.notConfigured);
    expect(error.message).toContain('COMPOSIO_AUTH_CONFIG_SLACK');
    expect(error.message).not.toContain(API_KEY);
    expect(fake).not.toHaveBeenCalled();
  });

  it('rejects a toolkit slug that cannot name an env var', async () => {
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: '../x', callbackUrl: 'https://a.example'}),
    );
    expect(error.code).toBe(COMPOSIO_ERROR_CODES.invalidToolkit);
  });

  it('never prints the key from an error', async () => {
    stubFetch(500, {});
    const error = await caught(
      composioFor(ENV).createConnectLink({tenantId: TENANT_ID, toolkit: 'github', callbackUrl: 'https://a.example'}),
    );
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify({error, ...error})).not.toContain(API_KEY);
    expect(String(error.stack)).not.toContain(API_KEY);
  });
});
