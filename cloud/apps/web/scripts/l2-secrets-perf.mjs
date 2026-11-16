import { chromium } from '@playwright/test';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = `${homedir()}/.praxis-agent-state/cloud/design/L/L2`;
const browser = await chromium.launch({ headless: !process.env.HEADED });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev', userId: 'l2-perf-' + Date.now() } });
for (let i = 0; i < 300; i++) {
  const secret = i % 4 === 0;
  await page.request.post(BASE + '/v1/saved-values', { data: { name: (secret ? 'token_' : 'var_') + String(i).padStart(3, '0'), kind: secret ? 'secret' : 'variable', value: secret ? 'SYNTH-' + i : 'value ' + i + ' ' + 'x'.repeat(i % 40) } });
}
await page.goto(BASE + '/settings/saved-values');
const box = page.getByTestId('saved-values-box');
const rows = box.locator('[data-testid^="saved-value-"]:not([data-testid="saved-value-skeleton"])');
await rows.nth(39).waitFor();
// Scroll the box to the end repeatedly with the wheel, recording frame intervals.
await page.evaluate(() => {
  const f = (window.__f = []); let last = performance.now();
  const loop = (t) => { f.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
const bb = await box.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
for (let i = 0; i < 90; i++) { await page.mouse.wheel(0, 180); await page.waitForTimeout(16); }
await page.waitForTimeout(500);
const frames = await page.evaluate(() => { window.__stop = true; return window.__f.slice(2); });
const loaded = await rows.count();
frames.sort((a, b) => a - b);
const pct = (p) => +frames[Math.min(frames.length - 1, Math.floor(p * frames.length))].toFixed(1);
// Search latency: type a query, time until the list holds only matches and is painted.
const latencies = [];
for (const q of ['var_12', 'token_2', 'value 7', 'zzz', 'var_29']) {
  await page.getByLabel('Search saved values').fill('');
  await page.waitForTimeout(400);
  const ms = await page.evaluate(async (q) => {
    const input = document.querySelector('input[aria-label="Search saved values"]');
    const boxEl = document.querySelector('[data-testid="saved-values-box"]');
    const settled = () => {
      const r = [...boxEl.querySelectorAll('[data-testid^="saved-value-"]')].filter((n) => n.dataset.testid !== 'saved-value-skeleton');
      const empty = boxEl.textContent.includes('No matches.');
      const name = q.split(' ')[0];
      return !boxEl.querySelector('[data-testid="saved-value-skeleton"]') && (empty || (r.length > 0 && r.every((n) => n.textContent.toLowerCase().includes(q.toLowerCase()))));
    };
    const t0 = performance.now();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, q); input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => { const tick = () => (settled() ? requestAnimationFrame(() => resolve()) : requestAnimationFrame(tick)); requestAnimationFrame(tick); });
    return +(performance.now() - t0).toFixed(1);
  }, q);
  latencies.push({ q, ms });
}
const result = { headed: !!process.env.HEADED, loadedAfterScroll: loaded, frameMs: { p50: pct(0.5), p95: pct(0.95), max: pct(0.999), n: frames.length }, longFrames: frames.filter((f) => f > 34).length, searchLatencyMs: latencies, debounceMs: 120 };
writeFileSync(`${OUT}/secrets-perf${process.env.HEADED ? '-headed' : ''}.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
await browser.close();
