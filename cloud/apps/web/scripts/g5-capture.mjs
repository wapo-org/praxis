// WP-G5 captures: our sidebar beside the owner's sidebar-design.html for all six palettes (desk and phone
// drawer, DPR 2), the button colours, the Settings controls. Compose with g5-compare.py.
// BASE=http://127.0.0.1:5261 OUT=~/.praxis-agent-state/cloud/design/G5/raw node apps/web/scripts/g5-capture.mjs
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5261';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G5/raw`;
const REF = `file://${homedir()}/.praxis-agent-state/cloud/design/G4-ref/sidebar-design.html`;
const PALETTES = ['Graphite', 'Midnight', 'Forest', 'Plum', 'Sand', 'Paper'];
const BUTTONS = ['White', 'Cyan', 'Navy', 'Gray', 'Graphite', 'Coral', 'Lime'];
const SIZES = { desk: { width: 1440, height: 900 }, phone: { width: 402, height: 874 } };
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const pad = 6;
const crop = async (page, locator, path) => {
  const box = await locator.boundingBox();
  await page.screenshot({
    path,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
  return box;
};
const boxes = {};
for (const [size, viewport] of Object.entries(SIZES)) {
  // The reference: the owner's bundle, palette chosen through its own panel (P).
  const refContext = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const ref = await refContext.newPage();
  await ref.goto(REF);
  await ref.locator('aside').waitFor();
  await ref.evaluate(() => document.fonts.ready);
  for (const name of PALETTES) {
    await ref.keyboard.press('p');
    await ref.locator(`button[title="${name}"]`).first().click();
    await ref.keyboard.press('p');
    await ref.mouse.move(viewport.width - 5, viewport.height - 5);
    await ref.waitForTimeout(150);
    boxes[`${size}-ref`] = await crop(ref, ref.locator('aside'), `${OUT}/${size}-${name.toLowerCase()}-ref.png`);
  }
  await refContext.close();

  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
    await context.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev' } });
    const chats = await (await context.request.get(BASE + '/v1/chats?limit=100')).json();
    for (const chat of chats.items) await context.request.delete(BASE + '/v1/chats/' + chat.id);
    let selected;
    for (const title of ['Regex help', 'Trip packing list', 'New chat4et'])
      selected = await (await context.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title } })).json();
    for (const name of PALETTES) {
      const page = await context.newPage();
      await page.addInitScript(
        ([t, p]) => {
          localStorage.setItem('praxis-theme', t);
          localStorage.setItem('praxis-sidebar-palette', p);
          localStorage.setItem('praxis-button-color', '#ffffff');
        },
        [theme, name.toLowerCase()],
      );
      await page.goto(BASE + '/c/' + selected.id);
      await page.getByTestId('chat-top-bar').waitFor();
      if (size === 'phone') await page.getByTestId('nav-history-button').click();
      await page.getByTestId('app-sidebar').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
      await page.waitForTimeout(700);
      boxes[`${size}-ours`] = await crop(page, page.getByTestId('app-sidebar'), `${OUT}/${size}-${name.toLowerCase()}-${theme}-ours.png`);
      if (name === 'Graphite') await page.screenshot({ path: `${OUT}/${size}-${theme}-full.png` });
      await page.close();
    }
    if (size === 'desk') {
      const page = await context.newPage();
      await page.addInitScript((t) => {
        localStorage.setItem('praxis-theme', t);
        localStorage.setItem('praxis-sidebar-palette', 'graphite');
      }, theme);
      await page.goto(BASE + '/c/' + selected.id);
      await page.getByTestId('sidebar-new-chat').waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const name of BUTTONS) {
        await page.evaluate((n) => {
          const colors = { White: '#ffffff', Cyan: '#79e0f8', Navy: '#1d4056', Gray: '#8d8d99', Graphite: '#2b2e33', Coral: '#f4846b', Lime: '#b6e36b' };
          localStorage.setItem('praxis-button-color', colors[n]);
          window.dispatchEvent(new StorageEvent('storage', { key: 'praxis-button-color' }));
        }, name);
        await page.waitForTimeout(100);
        await crop(page, page.getByTestId('sidebar-new-chat').locator('xpath=..'), `${OUT}/button-${name.toLowerCase()}-${theme}.png`);
      }
      await page.evaluate(() => {
        localStorage.setItem('praxis-button-color', '#ffffff');
        window.dispatchEvent(new StorageEvent('storage', { key: 'praxis-button-color' }));
      });
      await page.goto(BASE + '/settings/general');
      const look = page.getByTestId('sidebar-look');
      await look.waitFor();
      const palettes = look.getByRole('radiogroup', { name: 'Sidebar palette' });
      await palettes.getByRole('radio', { name: 'Midnight', exact: true }).click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/settings-${theme}-full.png` });
      await crop(page, look, `${OUT}/settings-${theme}.png`);
      await palettes.getByRole('radio', { name: 'Graphite', exact: true }).click();
      await page.close();
    }
    await context.close();
  }
}
console.log(JSON.stringify(boxes));
await browser.close();
