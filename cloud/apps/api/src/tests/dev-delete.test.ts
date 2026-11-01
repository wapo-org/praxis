import { expect, it } from 'vitest';
import { createLocalAdapters } from '../local-memory.js';
import { localModules } from '../modules.js';
import { createPraxisApp } from '../server.js';

const API = 'http://127.0.0.1:8823';
it('dev:local: after DELETE /v1/account the dev user gets 401, then a fresh dev sign-in is a clean account', async () => {
  const { app, service } = createPraxisApp({
    adapters: createLocalAdapters(),
    local: true,
    modules: localModules(API),
  });
  await service.seed('local-user');
  const call = (path: string, method = 'GET', token?: string, body?: unknown) =>
    app.request(API + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const signIn = async () =>
    (await (await call('/v1/auth/dev', 'POST', undefined, { type: 'auth.dev' })).json())
      .bearerToken;
  const token = await signIn();
  expect(
    (await call('/v1/chats', 'POST', token, { type: 'chat.input', title: 'Before deletion' }))
      .status,
  ).toBe(201);
  await call('/v1/skills/javascript-kv', 'GET', token);
  expect((await call('/v1/account', 'DELETE', token, {})).status).toBe(200);
  for (const path of ['/v1/bootstrap', '/v1/chats', '/v1/auth/session'])
    expect((await call(path, 'GET', token)).status, path).toBe(401);
  const again = await call('/v1/auth/dev', 'POST', undefined, { type: 'auth.dev' });
  expect(again.status).toBe(200);
  const fresh = (await again.json()).bearerToken;
  const boot = await call('/v1/bootstrap', 'GET', fresh);
  expect(boot.status).toBe(200);
  const chats = await (await call('/v1/chats', 'GET', fresh)).json();
  expect(chats.items.map((c: { title: string }) => c.title)).not.toContain('Before deletion');
  expect(
    (await call('/v1/chats', 'POST', fresh, { type: 'chat.input', title: 'After' })).status,
  ).toBe(201);
  // Deleting the recreated account works the same way again.
  expect((await call('/v1/account', 'DELETE', fresh, {})).status).toBe(200);
  expect((await call('/v1/bootstrap', 'GET', fresh)).status).toBe(401);
});
