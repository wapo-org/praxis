import { describe, expect, it } from 'vitest';
import { createMemoryAdapters } from './memory.js';
import { authFromRPC, createAuth, parseOrigins } from './auth.js';
import { convexHarness } from './testing/convex-harness.js';

const API = 'http://localhost:8791';

function fixture(withCache = false, baseURL = API) {
  const { rpc } = convexHarness();
  const cache = withCache ? createMemoryAdapters().kv : undefined;
  const auth = authFromRPC(rpc, {
    baseURL,
    trustedOrigins: ['http://localhost:5173'],
    secret: 'test-better-auth-secret-long-enough-for-test',
    cache,
  });
  return { auth, cache };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${API}/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (headers: Record<string, string>) => new Request(`${API}/v1/bootstrap`, { headers });
const credentials = { type: 'auth.input', email: 'alice@example.com', password: 'a-long-test-password', name: 'Alice' };

describe('Better Auth on the executable Convex database', () => {
  it('signs up, resolves cookie and bearer, signs in, rejects a wrong password, revokes on sign-out', async () => {
    const { auth } = fixture();
    const response = await auth.handler(post('sign-up', credentials, { origin: 'http://localhost:5173' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ type: 'session', user: { type: 'user', name: 'Alice', email: 'alice@example.com' } });
    expect(body.bearerToken).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('password');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const bearer = get({ authorization: `Bearer ${body.bearerToken}` });
    expect((await auth.resolveSession(bearer))?.user.id).toBe(body.user.id);

    const setCookies = response.headers.getSetCookie();
    expect(setCookies.join('\n')).toMatch(/HttpOnly/i);
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    expect(cookie).toContain('session_token');
    expect((await auth.resolveSession(get({ cookie })))?.user.id).toBe(body.user.id);

    expect(await auth.resolveSession(get({ authorization: 'Bearer forged' }))).toBeNull();
    expect(await auth.resolveSession(get({}))).toBeNull();

    expect((await auth.handler(post('sign-in', { ...credentials, password: 'wrong-password-123' }))).status).toBe(401);
    const login = await auth.handler(post('sign-in', credentials));
    expect(login.status).toBe(200);
    const second = await login.json();
    expect(second.user.id).toBe(body.user.id);
    expect(second.bearerToken).not.toBe(body.bearerToken);

    const out = await auth.handler(post('sign-out', {}, { authorization: `Bearer ${body.bearerToken}` }));
    expect(out.status).toBe(200);
    expect(await auth.resolveSession(bearer)).toBeNull();
    // Other sessions stay valid.
    expect((await auth.resolveSession(get({ authorization: `Bearer ${second.bearerToken}` })))?.user.id).toBe(body.user.id);
  });

  it('rejects untrusted browser origins, duplicate emails, bad input and unknown routes', async () => {
    const { auth } = fixture();
    expect((await auth.handler(post('sign-up', credentials, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await auth.handler(post('sign-in', credentials, { origin: 'null' }))).status).toBe(403);
    expect((await auth.handler(post('sign-up', credentials))).status).toBe(201);
    const duplicate = await auth.handler(post('sign-up', credentials));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.status).toBeLessThan(500);
    expect((await auth.handler(post('sign-up', { ...credentials, password: 'short' }))).status).toBe(400);
    const notJson = new Request(`${API}/v1/auth/sign-in`, { method: 'POST', body: '{nope' });
    expect((await auth.handler(notJson)).status).toBe(400);
    expect((await auth.handler(post('delete-user', {}))).status).toBe(404);
  });

  it('caches resolved sessions under hashed keys and drops them on sign-out', async () => {
    const { auth, cache } = fixture(true);
    const body = await (await auth.handler(post('sign-up', credentials))).json();
    const request = get({ authorization: `Bearer ${body.bearerToken}` });
    const keys: string[] = [];
    const set = cache!.set.bind(cache);
    cache!.set = async (key, value, ttl) => {
      keys.push(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(key.startsWith('session:revoked:') ? 8 * 86400 : 60);
      return set(key, value, ttl);
    };
    expect((await auth.resolveSession(request))?.user.id).toBe(body.user.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^session:[\w-]{43}$/);
    expect(keys[0]).not.toContain(body.bearerToken);
    expect((await auth.resolveSession(request))?.user.id).toBe(body.user.id);
    expect(keys).toHaveLength(1);
    await auth.handler(post('sign-out', {}, { authorization: `Bearer ${body.bearerToken}` }));
    expect(await cache!.get(keys[0]!)).toBeNull();
    expect(await auth.resolveSession(request)).toBeNull();
  });

  it('fails closed on incomplete or insecure configuration', () => {
    const { rpc } = convexHarness();
    const base = { trustedOrigins: [], secret: 's'.repeat(40) };
    expect(() => authFromRPC(rpc, { ...base, baseURL: 'http://api.example.com' })).toThrow('HTTPS');
    expect(() => authFromRPC(rpc, { ...base, baseURL: API, secret: 'short' })).toThrow();
    expect(() => authFromRPC(rpc, { ...base, baseURL: API, cookieSameSite: 'none' })).toThrow('HTTPS');
    expect(() => createAuth({})).toThrow();
    expect(() => createAuth({ CONVEX_URL: 'https://x.convex.cloud', BETTER_AUTH_SECRET: 's'.repeat(40) })).toThrow();
    expect(() => parseOrigins('https://app.example.com/path')).toThrow();
    expect(parseOrigins('https://a.example, http://localhost:5173/')).toEqual(['https://a.example', 'http://localhost:5173']);
  });
});

describe('REV-A2 cross-credential session revocation', () => {
  it.each(['bearer', 'cookie'])('revokes all cached aliases when signing out through %s', async credential => {
    const {auth} = fixture(true);
    const response = await auth.handler(post('sign-up', credentials));
    const body = await response.json();
    const bearer = {authorization: `Bearer ${body.bearerToken}`};
    const cookie = {cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')};
    const other = await (await auth.handler(post('sign-in', credentials))).json();
    expect(await auth.resolveSession(get(bearer))).not.toBeNull();
    expect(await auth.resolveSession(get(cookie))).not.toBeNull();
    expect((await auth.handler(post('sign-out', {}, credential === 'bearer' ? bearer : cookie))).status).toBe(200);
    expect(await auth.resolveSession(get(cookie))).toBeNull();
    expect(await auth.resolveSession(get(bearer))).toBeNull();
    expect(await auth.resolveSession(get({authorization: `Bearer ${other.bearerToken}`}))).not.toBeNull();
  });
});


it('HTTPS cookies have Secure/HttpOnly/SameSite and sign-in rotates an existing session; bearer expires', async () => {
  const {auth} = fixture(true, 'https://api.example.test');
  const signup = await auth.handler(post('sign-up', credentials));
  const session = await signup.json();
  const cookies = signup.headers.getSetCookie();
  expect(cookies.some(c => /session_token=/.test(c) && /Secure/i.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');
  const login = await auth.handler(post('sign-in', credentials, {cookie}));
  expect((await login.json()).bearerToken).not.toBe(session.bearerToken);
  const expiry = Date.parse(session.expiresAt);
  expect(expiry - Date.now()).toBeGreaterThan(6 * 86400000);
  expect(expiry - Date.now()).toBeLessThanOrEqual(7 * 86400000);
});
