// WP-PRA59 visual check; key endpoints are route-stubbed, so OpenRouter is never called with a key.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5230';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/WP-PRA59`;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 900 }, phone: { width: 402, height: 874 } };
const KEY = { type: 'modelKey', maskedKey: '••••9f3c', label: 'sk-or-v1-4a1...f3c', connectedAt: '2026-11-15T10:00:00.000Z', limit: 25, limitRemaining: 19.5 };

for (const [name, viewport] of Object.entries(viewports)) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.addInitScript(() => localStorage.setItem('praxis-theme', 'light'));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const shot = async (label) => { await page.waitForTimeout(450); await page.screenshot({ path: join(OUT, `${name}-${label}.png`) }); };
  await page.goto(BASE);
  const signIn = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([signIn.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await signIn.isVisible()) await signIn.click();
  await page.getByTestId('chat-top-bar').waitFor();
  // A clean account state for this run, whatever an earlier run left behind.
  await page.evaluate(async () => { await fetch('/v1/model-key', { method: 'DELETE', credentials: 'include', headers: { Authorization: 'Bearer dev-local' } }); });

  // 1. Not connected.
  await page.goto(`${BASE}/settings/models`);
  await page.getByTestId('openrouter-disconnected').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await shot('card-not-connected');

  // 2. Connect: the redirect goes to OpenRouter with an S256 challenge and this origin's callback.
  const redirect = page.waitForRequest((r) => r.url().startsWith('https://openrouter.ai/auth'));
  await page.route('https://openrouter.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>OpenRouter</title>' }));
  await page.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
  const auth = new URL((await redirect).url());
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('callback_url'), `${BASE}/settings/openrouter/callback`);
  assert.match(auth.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);

  // 3. The callback: OpenRouter sends the user back with a code; the API (stubbed) answers with the masked record.
  let exchange;
  await page.route('**/v1/model-key', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    exchange = route.request().postDataJSON();
    await route.fulfill({ json: KEY });
  });
  await page.goto(`${BASE}/settings/openrouter/callback?code=demo-code`);
  await page.getByTestId('openrouter-connected').waitFor();
  assert.equal(exchange.method, 'pkce');
  assert.equal(exchange.code, 'demo-code');
  assert.match(exchange.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(page.url()).pathname, '/settings/models');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('praxis.openrouter.pkce-verifier')), null);
  await shot('card-connected');

  // 4. A replayed callback link: the verifier is gone, so it is refused with a clear message.
  exchange = undefined;
  await page.goto(`${BASE}/settings/openrouter/callback?code=demo-code`);
  await page.getByRole('alert').filter({ hasText: 'already used' }).waitFor();
  assert.equal(exchange, undefined);
  await shot('callback-replayed');

  // 5. A key OpenRouter rejected.
  await page.route('**/v1/bootstrap', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), modelKey: { ...KEY, lastError: 'User not found.' } } });
  });
  await page.goto(`${BASE}/settings/models`);
  await page.getByTestId('openrouter-key-error').waitFor();
  await shot('card-key-rejected');
  await page.unroute('**/v1/bootstrap');

  // 6. Paste fallback (no key on the account).
  await page.goto(`${BASE}/settings/models`);
  await page.getByTestId('openrouter-disconnected').waitFor();
  await page.getByRole('button', { name: 'Paste a key instead', exact: true }).click();
  await page.getByTestId('openrouter-paste-form').waitFor();
  await shot('card-paste');

  // 7. The catalogue in the tray: recommended first, context window and price per row; search by name.
  await page.goto(BASE);
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('plus-tray').waitFor();
  await page.getByTestId('tray-model-picker-trigger').click();
  const list = page.getByRole('listbox', { name: 'Models' });
  await list.getByText('Recommended', { exact: true }).waitFor();
  await list.getByText(/context · /).first().waitFor();
  await shot('model-list');
  await page.getByRole('combobox', { name: 'Search models' }).fill('haiku');
  await list.getByRole('option').filter({ hasText: /haiku/i }).first().waitFor();
  await shot('model-list-search');
  await list.getByRole('option').filter({ hasText: /haiku/i }).first().click();
  await page.keyboard.press('Escape');

  // 8. Composer with no key and a real model selected: sending opens the connect card, the draft stays.
  await page.getByTestId('composer-input').fill('Hello from the visual check');
  await page.getByTestId('composer-send-button').click();
  await page.waitForURL('**/settings/models');
  await page.getByTestId('openrouter-disconnected').waitFor();
  await shot('composer-no-key');
  await context.close();
  console.log(`PASS ${name}`);
}
await browser.close();
console.log(`Screenshots: ${OUT}`);
