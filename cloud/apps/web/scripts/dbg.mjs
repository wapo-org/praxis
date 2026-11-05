import { chromium } from '@playwright/test';
const BASE = 'http://localhost:5212';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
await page.goto(BASE);
await page.evaluate(() => fetch('/v1/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'auth.dev' }) }));
await page.reload();
await page.waitForTimeout(1500);
const dragSelector = '[data-testid="app-sidebar"] [data-testid="sidebar-new-chat"]';
const transformSelector = '[data-testid="app-sidebar"] [data-elastic-surface]';
console.log('pre: drag found?', await page.locator(dragSelector).count(), 'transform found?', await page.locator(transformSelector).count());
const box = await page.locator(dragSelector).boundingBox();
console.log('box:', JSON.stringify(box));
await page.mouse.move(box.x + 10, box.y + 10);
await page.mouse.down();
for (let i = 1; i <= 24; i++) {
  await page.mouse.move(box.x + box.width / 2 + i * 3, box.y + box.height / 2 + i * 1.5);
  await page.waitForTimeout(16);
}
console.log('mid: drag found?', await page.locator(dragSelector).count(), 'transform found?', await page.locator(transformSelector).count());
const mid = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return (el?.closest?.('[data-elastic-surface]') ?? el).style.transform;
}, transformSelector);
console.log('mid:', JSON.stringify(mid));
await page.mouse.up();
await page.waitForTimeout(900);
console.log('rest:', await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return (el?.closest?.('[data-elastic-surface]') ?? el).style.transform;
}, transformSelector));
console.log('sidebar open after:', await page.getByTestId('app-sidebar').count());
await browser.close();
