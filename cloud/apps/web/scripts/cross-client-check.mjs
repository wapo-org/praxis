import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
// RC1 live cross-client: (1) a run started in web tab A is followed live in a separate browser context B
// (user events channel) and approved there; (2) a run started through the API is approved in the web.
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth });
  assert.ok(res.ok, `${init.method ?? 'GET'} ${path}: ${res.status}`);
  return res.json();
};
const settle = async (id) => {
  for (let i = 0; i < 150; i++) {
    const { run } = await api(`/v1/runs/${id}/snapshot`);
    if (['completed', 'cancelled', 'failed'].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'timeout';
};
const browser = await chromium.launch();
try {
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Continue as local dev user' }).click();
    await page.getByTestId('chat-top-bar').waitFor();
    return page;
  };
  const suffix = Date.now();
  const chat = await api('/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ type: 'chat.input', title: `RC1 ${suffix}` }),
  });
  const [a, b] = [await open(), await open()];
  for (const page of [a, b]) {
    await page.goto(`${BASE}/c/${encodeURIComponent(chat.id)}`);
    await page.getByTestId('composer-input').waitFor();
  }
  // 1. Web A starts an approval run; B was already open, so it can only learn of the run live.
  const text = `Please approve RC1 web run ${suffix}`;
  await a.getByTestId('composer-input').fill(text);
  await a.getByTestId('composer-send-button').click();
  await a.getByTestId('approval-allow-once').waitFor();
  const inB = b.getByTestId('chat-screen');
  await inB.getByText(text).first().waitFor();
  await b.getByTestId('approval-allow-once').click();
  await a.waitForFunction(() => !document.querySelector('[data-testid=approval-allow-once]'));
  await a.waitForFunction(() => !document.querySelector('[data-testid=composer-stop-button]'));
  const afterWeb = await api(`/v1/chats/${chat.id}/messages`);
  const webRunId = afterWeb.items
    .map((m) => m.runId)
    .filter(Boolean)
    .at(-1);
  assert.ok(webRunId, 'web run id recorded on its messages');
  assert.equal(await settle(webRunId), 'completed');
  // 2. The reverse: a run started through the API (as iOS would) is approved in web B.
  const remote = await api('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      type: 'run.start',
      chatId: chat.id,
      text: `RC1 API run ${suffix}`,
      script: 'approval',
    }),
  });
  await inB.getByText(`RC1 API run ${suffix}`).first().waitFor();
  await b.getByTestId('approval-allow-once').click();
  assert.equal(await settle(remote.id), 'completed');
  await a.getByTestId('chat-screen').getByText(`RC1 API run ${suffix}`).first().waitFor();
  await a.waitForFunction(() => !document.querySelector('[data-testid=approval-allow-once]'));
  console.log(
    `PASS: web-started run followed live and approved in a second context (run completed); API-started run approved in web and seen in both`,
  );
} finally {
  await browser.close();
}
