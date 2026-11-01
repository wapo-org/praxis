import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {authFromRPC} from '../adapters/auth.js';
import {storeFromRPC} from '../adapters/convex.js';
import {convexHarness} from '../adapters/testing/convex-harness.js';
import {createLocalAdapters} from '../local-memory.js';
import {createPraxisApp} from '../server.js';

const API = 'http://localhost:8791';
const WEB = 'http://localhost:5173';

/** Production-mode API (no dev auth) with Better Auth and the Store on the executable Convex database. */
function setup() {
  const {rpc} = convexHarness();
  const memory = createLocalAdapters();
  const auth = authFromRPC(rpc, {baseURL: API, trustedOrigins: [WEB], secret: 'e2e-better-auth-secret-long-enough-0123456789', cache: memory.kv});
  const {app} = createPraxisApp({
    adapters: {store: storeFromRPC(rpc), kv: memory.kv, events: memory.events},
    local: false,
    encryptionKey: randomBytes(32).toString('base64'),
    allowedOrigins: [WEB],
    resolveSession: r => auth.resolveSession(r),
    authHandler: r => auth.handler(r),
  });
  const call = (path: string, init: {method?: string; headers?: Record<string, string>; body?: unknown} = {}) =>
    app.request(`${API}${path}`, {method: init.method ?? (init.body ? 'POST' : 'GET'), headers: {'content-type': 'application/json', ...init.headers}, ...(init.body ? {body: JSON.stringify(init.body)} : {})});
  return {call};
}
const input = (email: string) => ({type: 'auth.input', email, password: 'correct-horse-battery', name: email.split('@')[0]});

describe('Better Auth end to end through the API', () => {
  it('iOS bearer and web cookie sessions: sign-up, sign-in, protected routes, CSRF origin check, sign-out revocation, isolation', async () => {
    const {call} = setup();
    expect((await call('/v1/bootstrap')).status).toBe(401);
    expect((await call('/v1/auth/dev', {body: {type: 'auth.dev'}})).status).toBe(404); // dev auth does not exist here

    // iOS: no Origin header; uses the bearer token from the response body.
    const signUp = await call('/v1/auth/sign-up', {body: input('ios@example.com')});
    expect(signUp.status).toBe(201);
    const ios = await signUp.json();
    expect(ios.bearerToken).toBeTruthy();
    const bearer = {authorization: `Bearer ${ios.bearerToken}`};
    const boot = await call('/v1/bootstrap', {headers: bearer});
    expect(boot.status).toBe(200);
    expect((await boot.json()).user.id).toBe(ios.user.id);
    const chat = await (await call('/v1/chats', {headers: bearer, body: {type: 'chat.input', title: 'Mine'}})).json();
    expect(chat.id).toBeTruthy();

    // Web: allowlisted Origin; the session travels as an httpOnly cookie, no bearer.
    expect((await call('/v1/auth/sign-in', {headers: {origin: 'https://evil.test'}, body: input('ios@example.com')})).status).toBe(403);
    expect((await call('/v1/auth/sign-in', {headers: {origin: WEB}, body: {...input('ios@example.com'), password: 'wrong-password-123'}})).status).toBe(401);
    const signIn = await call('/v1/auth/sign-in', {headers: {origin: WEB}, body: input('ios@example.com')});
    expect(signIn.status).toBe(200);
    const setCookie = signIn.headers.getSetCookie();
    expect(setCookie.some(c => /session_token=/.test(c) && /HttpOnly/i.test(c))).toBe(true);
    const cookie = {cookie: setCookie.map(c => c.split(';')[0]).join('; ')};
    expect((await call('/v1/bootstrap', {headers: cookie})).status).toBe(200);
    expect((await call('/v1/chats', {headers: {...cookie, origin: WEB}, body: {type: 'chat.input', title: 'From web'}})).status).toBe(201);
    expect((await call('/v1/chats', {headers: {...cookie, origin: 'https://evil.test'}, body: {type: 'chat.input', title: 'CSRF'}})).status).toBe(403);

    // Another user cannot see the first user's rows.
    const other = await (await call('/v1/auth/sign-up', {body: input('other@example.com')})).json();
    expect((await call(`/v1/chats/${chat.id}`, {headers: {authorization: `Bearer ${other.bearerToken}`}})).status).toBe(404);

    // Sign-out revokes exactly that session (and its cached lookup).
    expect((await call('/v1/auth/sign-out', {headers: bearer, method: 'POST', body: {}})).status).toBe(200);
    expect((await call('/v1/bootstrap', {headers: bearer})).status).toBe(401);
    expect((await call('/v1/bootstrap', {headers: cookie})).status).toBe(200);
    expect((await call('/v1/auth/sign-out', {headers: {...cookie, origin: WEB}, method: 'POST', body: {}})).status).toBe(200);
    expect((await call('/v1/bootstrap', {headers: cookie})).status).toBe(401);
  });
});
