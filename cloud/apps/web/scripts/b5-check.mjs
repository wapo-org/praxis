import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } }); page.setDefaultTimeout(20000);
  await page.goto(BASE); await page.getByRole('button', { name: 'Continue as local dev user' }).click();
  await page.getByTestId('chat-top-bar').waitFor();
  const controls = await page.evaluate(() => {
    const ink = document.createElement('span'); ink.style.background = 'var(--paper-ink)'; document.body.append(ink);
    const expected = getComputedStyle(ink).backgroundColor;
    const fills = ['.composer-camera', '[data-testid="composer-voice-button"]'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor);
    ink.remove(); return { expected, fills, history: !!document.querySelector('[data-testid="nav-history-button"] .tabler-icon-history') };
  });
  assert.equal(controls.history, true); assert.deepEqual(controls.fills, [controls.expected, controls.expected]);
  // Cold / must persist bootstrap before any chat mutation.
  await page.waitForFunction(async () => {
    const { loadReplica } = await import('/src/lib/idb.ts');
    return !!(await loadReplica())?.bootstrap;
  });
  const titlePatches = [];
  page.on('request', req => { if (req.method() === 'PATCH' && /\/v1\/chats\//.test(req.url()) && req.postDataJSON()?.title) titlePatches.push(req.postDataJSON()); });
  await page.getByTestId('composer-input').fill('**Server title** should be authoritative');
  await page.getByTestId('composer-send-button').click(); await page.waitForURL('**/c/*');
  const chatId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
  const server = await page.evaluate(async id => { const { apiClient } = await import('/src/lib/api.ts'); return apiClient.getChat(id); }, chatId);
  await page.getByTestId('nav-chat-title-pill').getByText(server.title, { exact: true }).waitFor();
  assert.equal(titlePatches.length, 0);
  await page.getByTestId('assistant-turn').first().waitFor();
  assert.equal(await page.getByTestId('turn-copy-button').first().textContent(), '');
  assert.equal(await page.getByTestId('turn-retry-button').first().textContent(), '');
  // Real user file -> API document part -> metadata-backed filename chip after reload.
  const input = { name: 'Protocol-notes.txt', mediaType: 'text/plain', size: Buffer.byteLength('Document attachment test'), chatId };
  const ticket = await page.evaluate(async input => {
    const { apiClient } = await import('/src/lib/api.ts');
    return apiClient.request('/v1/uploads', { method: 'POST', body: JSON.stringify({ type: 'upload.request', ...input }) });
  }, input);
  // API request context bypasses the local API's missing PUT CORS method; no response is mocked.
  const uploaded = await page.request.fetch(ticket.uploadUrl, { method: ticket.method, headers: { 'Content-Type': input.mediaType }, data: 'Document attachment test' });
  assert.equal(uploaded.ok(), true);
  const { storageId } = await uploaded.json();
  await page.evaluate(async ({ input, storageId }) => {
    const { apiClient } = await import('/src/lib/api.ts');
    const att = await apiClient.request('/v1/uploads/complete', { method: 'POST', body: JSON.stringify({ type: 'upload.complete', ...input, storageId }) });
    await apiClient.startRun({ chatId: input.chatId, text: 'Document', attachmentIds: [att.id], script: 'text' });
  }, { input, storageId });
  await page.reload(); await page.getByTestId('document-attachment-chip').filter({ hasText: 'Protocol-notes.txt' }).waitFor();
  await page.goto(`${BASE}/settings`); const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  assert.equal(await page.locator('.account-sign-out').count(), 0);
  assert.equal(await settings.getByRole('button', { name: 'Close settings' }).textContent(), 'Done');
  const tools = settings.locator('section').filter({ has: page.getByRole('heading', { name: 'Tools', exact: true }) });
  await tools.getByText('Voice input', { exact: true }).waitFor(); await tools.getByText('Image reading model', { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByRole('button', { name: 'Provider preset', exact: true }).click();
  await page.getByRole('menuitem', { name: 'OpenAI', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Base URL', exact: true }).inputValue(), 'https://api.openai.com/v1');
  await page.goto(`${BASE}/settings/connectors`);
  await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    await apiClient.createConnector({ name: 'Unreachable MCP', url: 'https://mcp.does-not-exist.invalid/mcp' });
  });
  await page.reload(); await page.getByText('Unreachable', { exact: false }).first().waitFor();
  assert.equal(await page.getByText('Connected', { exact: true }).count(), 0);
  await page.goto(`${BASE}/chats`);
  assert.equal(await page.locator('.screen-history-tools').count(), 0);
  const row = page.locator('.screen-history-row').filter({ hasText: server.title }).first();
  await row.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/settings`); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  console.log('PASS: first bootstrap replica; authoritative title/no client title PATCH; icon actions; real document chip; Account sign-out; Tools grouping/Done; glass Preset; unreachable connector health; contextual history actions');
} finally { await browser.close(); }
