import { chromium } from '@playwright/test';
import { homedir } from 'node:os';
const OUT = `${homedir()}/.praxis-agent-state/cloud/design/floating-glass`;
const BASE = 'http://localhost:5201';
const browser = await chromium.launch();
async function open(theme, w, h) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme });
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
// Seed a chat with tools + text, then capture chat + scrolled states.
const seed = await open('light', 1440, 900);
await seed.page.getByTestId('starter-chip-1').click();
await settle(seed.page);
for (const text of ['Summarise what the scripted tool returned.', 'Now turn that into three action items.', 'Which of those is riskiest?']) {
  await seed.page.getByTestId('composer-input').fill(text);
  await seed.page.getByTestId('composer-input').press('Enter');
  await settle(seed.page);
}
const chatPath = new URL(seed.page.url()).pathname;
await seed.context.close();
for (const theme of ['light', 'dark']) {
  for (const [name, w, h] of [['desktop',1440,900],['mobile',402,874]]) {
    const { context, page } = await open(theme, w, h);
    await page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, chatPath);
    await page.getByTestId('chat-top-bar').waitFor();
    await page.getByTestId('assistant-turn').first().waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-${theme}-chat.png` });
    await page.getByTestId('chat-scroll-viewport').evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-${theme}-chat-top.png` });
    // Stretch the sidebar mid-drag: capture the stretched state.
    if (name === 'desktop') {
      const sidebar = page.locator('[data-testid="app-sidebar"] [data-elastic-surface]');
      const box = await sidebar.boundingBox();
      await page.mouse.move(box.x + 140, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 220, box.y + 240, { steps: 10 });
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/${name}-${theme}-stretch-sidebar.png` });
      await page.mouse.up();
      await page.waitForTimeout(800);
    } else {
      // Mobile: floating history panel over the messages (content passes behind).
      await page.getByTestId('nav-history-button').click();
      await page.getByTestId('app-sidebar').waitFor();
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${OUT}/${name}-${theme}-history-panel.png` });
      await page.keyboard.press('Escape');
    }
    // Settings page.
    if (name === 'desktop') {
      await page.getByTestId('nav-settings-button').click();
      await page.getByTestId('settings-page').waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${theme}-settings.png` });
    } else {
      // Mobile: account lives in the floating history panel.
      await page.getByTestId('nav-history-button').click();
      await page.getByTestId('sidebar-account').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${theme}-settings.png` });
    }
    await context.close();
  }
}
// Consent popover (dev-only Lab demo drives the real popover).
for (const theme of ['light', 'dark']) {
  const { context, page } = await open(theme, 1440, 900);
  await page.evaluate(() => { history.pushState({}, '', '/lab'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByTestId('glass-lab-consent-demo').click();
  await page.getByTestId('consent-popover').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/desktop-${theme}-consent.png` });
  // Sending must stay blocked: type and try Enter; popover remains.
  await page.getByTestId('composer-input').fill('Must not send yet');
  await page.keyboard.press('Escape'); // must not dismiss
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/desktop-${theme}-consent-blocked.png` });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('consent-popover').waitFor({ state: 'detached' });
  await context.close();
}
await browser.close();
console.log('done');
