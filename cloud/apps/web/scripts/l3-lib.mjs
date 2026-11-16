// WP-L3 probe helpers. They need the L3 harness (apps/web/scripts/l3-server.ts): its fake upstream streams fixtures.
import { homedir } from 'node:os';
export const BASE = process.env.BASE ?? 'http://127.0.0.1:5241';
export const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/L/L3`;
export const TAG = process.env.TAG ?? 'after';

export async function open(browserType, { width = 1440, height = 900, dpr = 2, scheme = 'light', reducedMotion = 'no-preference', launch = {} } = {}) {
  const browser = await browserType.launch(launch);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: scheme, reducedMotion, serviceWorkers: 'block' });
  await context.addInitScript((mode) => localStorage.setItem('praxis-theme', mode), scheme);
  if (browserType.name() === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(async (mode) => { const { apiClient } = await import('/src/lib/api.ts'); await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field: 'theme', value: mode }) }).catch(() => {}); localStorage.setItem('praxis-theme', mode); }, scheme).catch(() => {});
  return { browser, context, page };
}

/** The fake upstream as a provider (once per API process), with consent for its host. */
export async function provider(page) {
  return page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    await apiClient.connectModelKey({method:'paste',apiKey:'sk-or-l3-test-key'});
    return 'openrouter';
  });
}

/** A chat on the fake upstream. `history` prompts are run to completion through the API first. */
export async function chat(page, { model = 'l3-80-150', title = 'L3 probe', history = [] } = {}) {
  await provider(page);
  const id = await page.evaluate(async ({ model, title, history }) => {
    const { apiClient } = await import('/src/lib/api.ts');
    const chat = await apiClient.createChat({ title, modelId: model });
    for (const text of history) {
      const run = await apiClient.startRun({ chatId: chat.id, text, modelId: 'l3-4000', clientTurnId: crypto.randomUUID() });
      for (let i = 0; i < 600; i++) {
        const snap = await apiClient.getRunSnapshot(run.id);
        if (['completed', 'failed', 'cancelled'].includes(snap.run.status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return chat.id;
  }, { model, title, history });
  await page.goto(`${BASE}/c/${id}`);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('composer-input').waitFor();
  if (history.length) await page.getByTestId('turn-copy-button').last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return id;
}

export async function send(page, text) {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await input.press('Enter');
}

/** Waits until the last answer is final (its action row is back) and fonts and code highlighting have settled. */
export async function settled(page, count = 1) {
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="turn-copy-button"]').length >= n && !document.querySelector('[data-testid="live-run-streaming-turn"]'), count, { timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
}

export const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null; };
export const round = (n, d = 1) => (n === null || n === undefined ? n : Math.round(n * 10 ** d) / 10 ** d);
