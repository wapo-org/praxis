// WP-H3b live probe: six chats made in the web UI (random names, scripted replies) on a fresh dev:local, then
// the orchestrator's six queries through /v1/search. BASE=http://127.0.0.1:5233 node apps/web/scripts/h3b-search-probe.mjs
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233';
const out = `${process.env.HOME}/.praxis-agent-state/cloud/design/H/H3b`;
await mkdir(out, { recursive: true });
const messages = ['Packing list for 3 days in Lisbon', 'Match a date like 2026-11-07 with a regular expression', 'Help me track my monthly expenses and spending', 'A quick chickpea curry recipe for tonight', 'My Python script crashes with KeyError when reading JSON', 'Plan to run a half marathon in 12 weeks'];
const cases = [['packing for a trip', 0], ['date regex', 1], ['budget', 2], ['dinner ideas', 3], ['debug code error', 4], ['fitness training', 5]];
const browser = await chromium.launch();
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).click();
  await page.getByTestId('chat-top-bar').waitFor();
  const titles = [];
  for (const text of messages) {
    await page.goto(`${BASE}/`);
    await page.getByTestId('composer-input').waitFor();
    await page.getByTestId('composer-input').fill(text);
    await page.getByTestId('composer-send-button').click();
    await page.waitForURL(/\/c\//);
    await page.getByTestId('chat-screen').getByText(text).first().waitFor();
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.querySelector('[data-testid=composer-stop-button]'));
    titles.push(await page.evaluate(async () => { const { apiClient } = await import('/src/lib/api.ts'); const id = decodeURIComponent(location.pathname.split('/').pop()); return (await apiClient.listChats({ limit: 100 })).items.find(c => c.id === id)?.title; }));
  }
  console.log('titles:', titles.join(' | '), new Set(titles).size === titles.length ? '(unique)' : '(DUPLICATE)');
  if (new Set(titles).size !== titles.length) failed++;
  await page.waitForTimeout(1500); // the debounced indexer
  for (const [q, want] of cases) {
    const hits = await page.evaluate(async q => { const { apiClient } = await import('/src/lib/api.ts'); return (await apiClient.searchChats(q)).items.map(h => ({ title: h.chat.title, snippet: h.snippet })); }, q);
    const ok = hits[0]?.title === titles[want];
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} "${q}" → ${hits.map(h => h.title).join(', ') || 'NOTHING'} (expected ${titles[want]}) — ${hits[0]?.snippet ?? ''}`);
  }
  for (const q of ['zebra quantum', 'learn guitar']) {
    const hits = await page.evaluate(async q => { const { apiClient } = await import('/src/lib/api.ts'); return (await apiClient.searchChats(q)).items.map(h => h.chat.title); }, q);
    console.log(`noise "${q}" → ${hits.join(', ') || 'NOTHING'}`);
  }
  // The palette, as the owner sees it.
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('fitness training');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/search-fitness-training.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('debug code error');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/search-debug-code-error.png` });
} finally { await browser.close(); }
console.log(failed ? `FAIL: ${failed}` : 'PASS: six random-name chats found by meaning; names unique');
process.exitCode = failed ? 1 : 0;
