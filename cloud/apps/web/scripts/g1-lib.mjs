// Shared helpers for the WP-G1 capture, motion and perf scripts.
import { chromium, webkit } from '@playwright/test';
import { homedir } from 'node:os';
export const BASE = process.env.BASE ?? 'http://127.0.0.1:5198';
export const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G1`;
export const engines = { chromium, webkit };

/** Open the app signed in as the local dev user. */
export async function openApp(browser, { theme = 'light', width = 1440, height = 900, dpr = 2, path = '/', video, reducedMotion } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme, reducedMotion,
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}),
  });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(BASE + path);
  const signIn = page.getByRole('button', { name: /local dev user/i });
  await Promise.race([signIn.waitFor(), page.getByTestId('app-sidebar').waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  await Promise.race([page.getByTestId('chat-top-bar').waitFor(), page.getByTestId('settings-page').waitFor()]);
  return { context, page };
}

/** A chat with real text and tools, so there is content to pass behind the glass. Returns its path. */
export async function seedChat(browser, turns = 6) {
  const { context, page } = await openApp(browser);
  const settle = () => page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 30000 }).catch(() => {});
  await page.getByTestId('starter-chip-1').click();
  await page.waitForTimeout(200);
  await settle();
  const lines = ['Summarise what the scripted tool returned, with a table and a code sample please.', 'Now turn that into three action items with reasons for each of them.', 'Which of those is riskiest, and what would you do first, in detail?', 'Write the rollback plan as a numbered list with owners and dates.', 'Rewrite the plan as a short status update for the whole team.', 'What should we measure to know it worked? Be specific about numbers.'];
  for (const text of lines.slice(0, turns)) {
    await page.getByTestId('composer-input').fill(text);
    await page.getByTestId('composer-input').press('Enter');
    await page.waitForTimeout(150);
    await settle();
  }
  const path = new URL(page.url()).pathname;
  await context.close();
  return path;
}

/** Sample a surface's edges every animation frame while `act` runs. */
export async function startEdges(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    window.__edges = [];
    window.__edgesOn = true;
    const tick = () => {
      if (!window.__edgesOn) return;
      const r = el.getBoundingClientRect();
      window.__edges.push({ t: performance.now(), l: r.left, r: r.right, t2: r.top, b: r.bottom });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}
export const stopEdges = (page) => page.evaluate(() => { window.__edgesOn = false; return window.__edges; });
