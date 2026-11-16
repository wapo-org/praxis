import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5231';
const UNCAPPED = !!process.env.UNCAPPED;
const browser = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...(UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
});
const page = await context.newPage();
await page.request.post(`${BASE}/v1/auth/dev`, { data: { type: 'auth.dev' } });
await page.goto(BASE);
const dev = page.getByRole('button', { name: /local dev user/i });
if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
await page.getByTestId('chat-top-bar').waitFor();
await page.waitForTimeout(1500);
const record = () => page.evaluate(() => {
  window.__f = [];
  window.__on = true;
  let last = performance.now();
  const tick = (now) => { if (!window.__on) return; window.__f.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const stop = () => page.evaluate(() => { window.__on = false; return window.__f.slice(1); });
const open = [];
const close = [];
await page.getByTestId('composer-plus-button').click();
await page.waitForTimeout(900);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const mark = await page.evaluate(() => window.__long.length);
for (let i = 0; i < Number(process.env.REPS ?? 8); i++) {
  await record();
  await page.getByTestId('composer-plus-button').click();
  await page.waitForTimeout(450);
  open.push(...(await stop()));
  await page.waitForTimeout(250);
  await record();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  close.push(...(await stop()));
  await page.waitForTimeout(250);
}
const stats = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const at = (q) => Math.round(s[Math.floor(s.length * q)] * 10) / 10;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(s[s.length - 1]) };
};
console.log(JSON.stringify({ label: process.env.LABEL, uncapped: UNCAPPED, open: stats(open), close: stats(close), longTasks: (await page.evaluate(() => window.__long)).slice(mark) }));
await browser.close();
