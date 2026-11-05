import { chromium } from '@playwright/test';
import { homedir } from 'node:os';
const OUT = `${homedir()}/.praxis-agent-state/cloud/design/floating-glass`;
const BASE = 'http://localhost:5201';
const browser = await chromium.launch();
async function open(theme, w, h, video) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme, recordVideo: video ? { dir: `${OUT}/video-tmp`, size: { width: w, height: h } } : undefined });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  const signIn = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([signIn.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  await page.getByTestId('chat-top-bar').waitFor();
  return { context, page };
}
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
};
// Seed chats.
const seed = await open('light', 1440, 900);
await seed.page.getByTestId('starter-chip-1').click();
await settle(seed.page);
for (const text of ['Summarise what the scripted tool returned.', 'Which of those is riskiest?']) {
  await seed.page.getByTestId('composer-input').fill(text);
  await seed.page.getByTestId('composer-input').press('Enter');
  await settle(seed.page);
}
await seed.page.getByTestId('sidebar-new-chat').click();
await settle(seed.page);
await seed.page.getByTestId('starter-chip-2').click(); // triggers approval flow? tools/approval
await seed.page.waitForTimeout(1500);
const chatPath = new URL(seed.page.url()).pathname;
// Record stretching in sequence on one page.
const rec = await open('light', 1440, 900, true);
await rec.page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, chatPath);
await rec.page.getByTestId('chat-top-bar').waitFor();
await rec.page.waitForTimeout(800);
async function stretch(page, locator, sx, sy, mx, my) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + sx, box.y + sy);
  await page.mouse.down();
  await page.mouse.move(mx, my, { steps: 20 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(1000);
}
// 1. Sidebar
await stretch(rec.page, rec.page.locator('[data-testid="app-sidebar"] [data-elastic-surface]'), 130, 200, 210, 240);
await rec.page.waitForTimeout(150);
// 2. Composer pill
await stretch(rec.page, rec.page.getByTestId('composer-surface'), 200, 24, 300, 60);
// 3. A glass button (top-bar settings cluster button area)
await stretch(rec.page, rec.page.getByTestId('nav-settings-button'), 15, 15, 60, 50);
// 4. An open menu
const row = rec.page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
await row.hover();
await row.getByRole('button', { name: /^Actions for/ }).click();
await rec.page.getByRole('menu').waitFor();
await rec.page.waitForTimeout(400);
await stretch(rec.page, rec.page.getByRole('menu'), 80, 40, 160, 90);
await rec.page.keyboard.press('Escape');
const video = await rec.page.video()?.path();
await rec.context.close();
console.log('video:', video);
// Screenshots: tray, menu, approval state, empty states.
for (const theme of ['light', 'dark']) {
  for (const [name, w, h] of [['desktop',1440,900],['mobile',402,874]]) {
    const { context, page } = await open(theme, w, h);
    await page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, chatPath);
    await page.getByTestId('chat-top-bar').waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${name}-${theme}-chat2.png` });
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('plus-tray').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-${theme}-tray.png` });
    await page.keyboard.press('Escape');
    if (name === 'desktop') {
      const r = page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
      await r.hover();
      await r.getByRole('button', { name: /^Actions for/ }).click();
      await page.getByRole('menu').waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/${name}-${theme}-menu.png` });
      await page.keyboard.press('Escape');
      // Approval state: start a tools run with approval script.
    }
    await context.close();
  }
}
// Empty states in remaining theme/size combos.
for (const theme of ['light', 'dark']) {
  for (const [name, w, h] of [['desktop',1440,900],['mobile',402,874]]) {
    const { context, page } = await open(theme, w, h);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-${theme}-empty.png` });
    await context.close();
  }
}
await browser.close();
console.log('done');
