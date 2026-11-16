import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? '/tmp/h3-raw';
const REF = `file://${homedir()}/.praxis-agent-state/cloud/design/G6-ref/zip/Chat%20Screen%20(standalone).html`;
const ALL = ['Graphite', 'Midnight', 'Forest', 'Plum', 'Sand', 'Paper'];
const PALETTES = process.argv.length > 2 ? ALL.filter((p) => process.argv.slice(2).includes(p.toLowerCase())) : ALL;
const viewport = { width: 1440, height: 900 };
const LONG = 40;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const pad = 6;
const crop = async (page, box, path) =>
  page.screenshot({ path, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });

// The reference, driven through its own panel (P) and Light/Dark toggle.
async function reference(theme, long) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const ref = await context.newPage();
  await ref.goto(REF);
  await ref.locator('aside').waitFor();
  await ref.evaluate(() => document.fonts.ready);
  await ref.keyboard.press('p');
  if (theme === 'dark') await ref.getByRole('button', { name: 'Dark mode' }).click();
  if (long) for (let i = 0; i < LONG - 3; i++) await ref.getByRole('button', { name: 'New chat' }).first().click();
  for (const name of PALETTES) {
    await ref.locator(`button[title="${name}"]`).first().click();
    await ref.keyboard.press('p');
    await ref.mouse.move(viewport.width - 5, viewport.height - 5);
    await ref.waitForTimeout(150);
    const tag = `${name.toLowerCase()}-${theme}${long ? '-long' : ''}`;
    await crop(ref, await ref.locator('aside').boundingBox(), `${OUT}/${tag}-ref-sidebar.png`);
    if (!long) await ref.screenshot({ path: `${OUT}/${tag}-ref-full.png` });
    await ref.keyboard.press('p');
  }
  await context.close();
}

async function ours(theme, long) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev' } });
  const chats = await (await context.request.get(BASE + '/v1/chats?limit=100')).json();
  for (const chat of chats.items) await context.request.delete(BASE + '/v1/chats/' + chat.id);
  const titles = ['Regex help', 'Trip packing list'];
  if (long) for (let i = 0; i < LONG - 3; i++) titles.push(['Quiet Harbor', 'Amber Fox', 'Lunar Comet', 'Wild Kettle', 'Misty Willow'][i % 5]);
  for (const title of titles) await context.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title } });
  const selected = await (await context.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title: 'New chat4et' } })).json();
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  await page.goto(BASE + '/c/' + selected.id);
  await page.getByTestId('composer-input').waitFor();
  // The source's four turns, through the scripted provider.
  if (!long)
    for (const text of ['fhfgj', 'htr', 'tej', 'htr']) {
      await page.getByTestId('composer-input').fill(text);
      await page.getByTestId('composer-send-button').click();
      await page.getByTestId('composer-voice-button').and(page.locator(':not([data-hidden])')).waitFor({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  for (const name of PALETTES) {
    await page.evaluate((p) => {
      localStorage.setItem('praxis-sidebar-palette', p);
      localStorage.setItem('praxis-button-color', '#ffffff');
      window.dispatchEvent(new StorageEvent('storage', { key: 'praxis-sidebar-palette' }));
    }, name.toLowerCase());
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(viewport.width - 5, viewport.height - 5);
    await page.waitForTimeout(500);
    const tag = `${name.toLowerCase()}-${theme}${long ? '-long' : ''}`;
    await crop(page, await page.getByTestId('app-sidebar').boundingBox(), `${OUT}/${tag}-ours-sidebar.png`);
    if (!long) await page.screenshot({ path: `${OUT}/${tag}-ours-full.png` });
  }
  await context.close();
}

for (const theme of ['light', 'dark'])
  for (const long of [false, true]) {
    await reference(theme, long);
    await ours(theme, long);
  }
await browser.close();
console.log('captured', PALETTES.join(','));
