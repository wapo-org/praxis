import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).click();
  await page.getByTestId('chat-top-bar').waitFor();
  // Finding 1: a missing API feature is an error, never a fabricated entity.
  await page.route('**/v1/connectors', r => r.fulfill({ status: 404, body: '{}' }));
  const unavailable = await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    try { await apiClient.createConnector({ name: 'Ghost', url: 'https://invalid.invalid' }); return 'FAKE'; }
    catch (error) { return error.message; }
  });
  assert.match(unavailable, /Not available/);
  // Finding 2: a 401 from any authenticated call unmounts the private store.
  await page.route('**/v1/bootstrap', r => r.fulfill({ status: 401, body: '{}' }));
  await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    try { await apiClient.bootstrap(); } catch {}
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-screen').count(), 0);
  // API crash probe: 30 sequential real scripted runs, bounded polling, no fixture mutation.
  const api = await browser.newContext();
  const session = await (await api.request.post(`${API}/v1/auth/dev`, { data: { type: 'auth.dev', userId: `wp-b1-probe-${Date.now()}` } })).json();
  const headers = { Authorization: `Bearer ${session.bearerToken}` };
  const chat = await (await api.request.post(`${API}/v1/chats`, { headers, data: { type: 'chat.input', title: 'WP-B1 crash probe' } })).json();
  for (let i = 0; i < 30; i++) {
    const response = await api.request.post(`${API}/v1/runs`, { headers, data: { type: 'run.start', chatId: chat.id, text: 'Tools probe', script: 'tools' } });
    assert(response.ok(), `run ${i}: ${response.status()} ${await response.text()}`);
    const run = await response.json();
    const snapshot = await api.request.get(`${API}/v1/runs/${run.id}/snapshot`, { headers });
    assert(snapshot.ok());
  }
  assert((await api.request.get(`${API}/health`)).ok());
  await api.close();
  console.log('PASS: missing-route error; bootstrap 401 sign-in; 30 tool runs + snapshots; API alive');
} finally { await browser.close(); }
