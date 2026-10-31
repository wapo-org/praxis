import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
// Cross-client live runs: runs started through the API (as iOS or another tab would) attach live in an open web chat.
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const start = async (chatId, text, script) => {
  const res = await fetch(`${API}/v1/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.start', chatId, text, script }) });
  assert.ok(res.ok, `run.start ${res.status}`);
  return res.json();
};
const status = async id => (await (await fetch(`${API}/v1/runs/${id}/snapshot`, { headers: auth })).json()).run.status;
const settle = async id => { for (let i = 0; i < 100; i++) { const s = await status(id); if (['completed', 'cancelled', 'failed'].includes(s)) return s; await new Promise(r => setTimeout(r, 100)); } return 'timeout'; };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.goto(BASE); await page.getByRole('button', { name: 'Continue as local dev user' }).click(); await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('composer-input').fill('Open chat for W3'); await page.getByTestId('composer-send-button').click();
  const chat = page.getByTestId('chat-screen');
  await chat.getByTestId('assistant-turn').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid=composer-stop-button]'));
  const chatId = new URL(page.url()).pathname.split('/').pop();
  // 1. Approval started elsewhere: the card appears live and is answerable here.
  const approval = await start(chatId, 'Remote approval run', 'approval');
  await chat.getByText('Remote approval run').first().waitFor();
  await page.getByTestId('approval-allow-once').click();
  assert.equal(await settle(approval.id), 'completed');
  await page.waitForFunction(() => !document.querySelector('[data-testid=approval-allow-once]'));
  // 2. Elicitation started elsewhere: answered from the web.
  const elicitation = await start(chatId, 'Remote elicitation run', 'elicitation');
  await page.getByTestId('elicitation-submit').waitFor();
  const input = page.getByTestId('elicitation-input-response');
  if (await input.count()) await input.first().fill('From web');
  await page.getByTestId('elicitation-submit').click();
  assert.equal(await settle(elicitation.id), 'completed');
  // 3. Tool rows and streamed text from a remote run.
  const tools = await start(chatId, 'Remote tools run', 'tools');
  await chat.getByTestId('agent-activity-view').last().waitFor();
  assert.equal(await settle(tools.id), 'completed');
  await chat.getByText('Remote tools run').first().waitFor();
  // 4. A run in another chat doesn't paint into this one.
  const other = await (await fetch(`${API}/v1/chats`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'chat.input', title: 'Other W3' }) })).json();
  const elsewhere = await start(other.id, 'Elsewhere run text', 'approval');
  await page.waitForTimeout(1500);
  assert.equal(await chat.getByText('Elsewhere run text').count(), 0);
  await fetch(`${API}/v1/runs/${elsewhere.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
  console.log('PASS: remote approval answered live on web; remote elicitation answered; remote tool rows + text; no cross-chat paint');
} finally { await browser.close(); }
