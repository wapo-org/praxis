// WP-D1 visual gate: empty state, ~6-turn chat with a tool row, open composer tray;
// 1440×900 and 402×874; light and dark; plus side-by-side with the iOS references.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5195';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/D1`;
const REF = new URL('../../../docs/web/reference/ios/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 402, height: 874 } };

async function open(theme, viewport, path = '/') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  const signIn = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([signIn.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await signIn.isVisible()) await signIn.click();
  await page.getByTestId('chat-top-bar').waitFor();
  if (path !== '/') await page.goto(`${BASE}${path}`);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  await page.waitForTimeout(400);
}

// Seed one real chat through the UI: a tool run plus five text turns.
const seed = await open('light', viewports.desktop);
await seed.page.getByTestId('starter-chip-1').click();
await settle(seed.page);
for (const text of [
  'Summarise what the scripted tool returned.',
  'Now turn that into three action items.',
  'Which of those is riskiest?',
  'Draft a short note for the team.',
  'Thanks — keep it under 80 words.',
]) {
  await seed.page.getByTestId('composer-input').fill(text);
  await seed.page.getByTestId('composer-input').press('Enter');
  await settle(seed.page);
}
const chatPath = new URL(seed.page.url()).pathname;
await seed.context.close();

const shots = [];
for (const theme of ['light', 'dark'])
  for (const [vpName, viewport] of Object.entries(viewports)) {
    const tag = `${vpName}-${theme}`;
    const empty = await open(theme, viewport);
    await empty.page.screenshot({ path: join(OUT, `${tag}-empty.png`) });
    await empty.context.close();
    const chat = await open(theme, viewport, chatPath);
    await chat.page.getByTestId('assistant-turn').first().waitFor();
    await chat.page.waitForTimeout(300);
    await chat.page.screenshot({ path: join(OUT, `${tag}-chat.png`) });
    await chat.page.getByTestId('chat-scroll-viewport').evaluate((el) => el.scrollTo({ top: 0 }));
    await chat.page.waitForTimeout(200);
    await chat.page.screenshot({ path: join(OUT, `${tag}-chat-top.png`) });
    await chat.page.getByTestId('chat-scroll-viewport').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await chat.page.getByTestId('composer-plus-button').click();
    await chat.page.getByTestId('plus-tray').waitFor();
    await chat.page.waitForTimeout(400);
    await chat.page.screenshot({ path: join(OUT, `${tag}-tray.png`) });
    await chat.page.keyboard.press('Escape');
    await chat.page.getByTestId('nav-chat-title-pill').click();
    await chat.page.getByTestId('settings-page').waitFor();
    await chat.page.waitForTimeout(500);
    await chat.page.screenshot({ path: join(OUT, `${tag}-sheet.png`) });
    await chat.page.goto(`${BASE}${chatPath}`); await chat.page.getByTestId('chat-top-bar').waitFor();
    if (vpName === 'desktop') {
      const row = chat.page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
      await row.hover();
      await row.getByRole('button', { name: /^Actions for/ }).click();
      await chat.page.getByRole('menu').waitFor();
      await chat.page.waitForTimeout(400);
      await chat.page.screenshot({ path: join(OUT, `${tag}-menu.png`) });
    }
    await chat.context.close();
    shots.push(tag);
  }

// Side-by-side boards: web (left) vs iOS reference (right).
const pairs = { empty: 'chat-0-bottom', chat: 'chat-0-bottom', tray: 'tray-2-main' };
const board = await browser.newPage({ viewport: { width: 1800, height: 900 } });
const dataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
for (const theme of ['light', 'dark'])
  for (const [state, ref] of Object.entries(pairs)) {
    const imgs = await Promise.all([
      dataUrl(join(OUT, `desktop-${theme}-${state}.png`)),
      dataUrl(join(OUT, `mobile-${theme}-${state}.png`)),
      dataUrl(join(REF, `${theme}-${ref}.png`)),
    ]);
    await board.setContent(`<body style="margin:0;display:flex;gap:16px;align-items:flex-start;padding:16px;background:#888;font:12px system-ui">
      <figure style="margin:0"><img src="${imgs[0]}" style="height:560px"><figcaption>web 1440</figcaption></figure>
      <figure style="margin:0"><img src="${imgs[1]}" style="height:560px"><figcaption>web 402</figcaption></figure>
      <figure style="margin:0"><img src="${imgs[2]}" style="height:560px"><figcaption>iOS ${theme}-${ref}</figcaption></figure></body>`);
    await board.screenshot({ path: join(OUT, `compare-${theme}-${state}.png`), fullPage: true });
  }
await browser.close();
console.log(JSON.stringify({ out: OUT, chatPath, shots }));
