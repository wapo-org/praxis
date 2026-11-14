// Samples the sent user bubble every animation frame from Enter until the run ends.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const files = (process.env.FILES ?? '/tmp/j2/fx/Chat screen draft.zip').split(',');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE);
const dev = page.getByRole('button', { name: 'Continue as local dev user' }); await dev.waitFor(); await dev.click();
await page.getByTestId('chat-top-bar').waitFor();
if (process.env.EXISTING) { await page.getByTestId('composer-input').fill('hello there'); await page.getByTestId('composer-input').press('Enter'); await page.getByTestId('assistant-turn').last().waitFor(); await page.waitForTimeout(1500); }
await page.getByTestId('composer-file-input').setInputFiles(files);
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__log = []; const t0 = performance.now();
  const tick = () => {
    const bubbles = [...document.querySelectorAll('[data-testid="user-message-bubble"]')];
    const last = bubbles.at(-1);
    const b = last?.querySelector('[data-user-bubble]');
    window.__log.push({ t: Math.round(performance.now() - t0), n: bubbles.length, vis: b ? getComputedStyle(b).visibility + '/' + getComputedStyle(b).opacity : 'none', text: (b?.textContent ?? '').slice(0, 30), flight: !!document.querySelector('[data-testid="send-flight-bubble"]'), stop: !!document.querySelector('[aria-label="Stop generating"]') });
    if (performance.now() - t0 < (window.__until ?? 8000)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.getByTestId('composer-input').fill("what's here");
await page.getByTestId('composer-input').press('Enter');
await page.waitForTimeout(8500);
const log = await page.evaluate(() => window.__log);
let prev = '';
for (const e of log) { const k = `${e.n} ${e.vis} ${e.text} flight=${e.flight} stop=${e.stop}`; if (k !== prev) console.log(e.t, k); prev = k; }
await browser.close();
