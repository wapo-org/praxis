// WP-J2 item 6: frame times while search closes in Chromium (Escape, clicking a result, clicking outside).
// Headed with GPU by default, like g2-perf. Writes a Chrome trace per path and a JSON summary.
//   BASE=http://127.0.0.1:5232 TAG=before|after [HEADLESS=1] node apps/web/scripts/j2-search-close.mjs
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const TAG = process.env.TAG ?? 'before';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/J/J2`;
const HEADED = !process.env.HEADLESS;
const RUNS = Number(process.env.RUNS ?? 5);
const browser = await chromium.launch({ headless: !HEADED, args: HEADED ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: true });
});
const page = await context.newPage();
await page.goto(BASE);
const dev = page.getByRole('button', { name: 'Continue as local dev user' });
await dev.waitFor(); await dev.click();
await page.getByTestId('chat-top-bar').waitFor();
// Something to find: a few chats with words in them.
await page.evaluate(async () => {
  const { apiClient } = await import('/src/lib/api.ts');
  for (const title of ['Packing list for Lisbon', 'Packing the studio', 'Pack animals']) {
    const chat = await apiClient.createChat({ title });
    await apiClient.startRun({ chatId: chat.id, text: `${title}: what should I pack?`, script: 'text', providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID() });
  }
});
await page.waitForTimeout(1500);

async function openSearch() {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByTestId('search-palette').waitFor();
  await page.getByRole('combobox', { name: 'Search conversations' }).fill('pack');
  await page.getByRole('option').nth(1).waitFor().catch(() => {});
  await page.waitForTimeout(500);
}

async function measure(label, close) {
  const frames = [];
  const after = [];
  const longs = [];
  for (let run = 0; run < RUNS; run++) {
    await openSearch();
    const cdp = await context.newCDPSession(page);
    const traceChunks = [];
    if (run === 0) {
      cdp.on('Tracing.dataCollected', (e) => traceChunks.push(...e.value));
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,toplevel', transferMode: 'ReportEvents' });
    }
    await page.evaluate(() => {
      window.__f = []; window.__go = true; window.__mark = performance.now(); window.__longStart = window.__long.length; window.__gone = Infinity;
      let last = performance.now();
      const tick = (t) => { window.__f.push([t, t - last]); last = t; if (window.__go) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const palette = document.querySelector('[data-testid="search-palette"]');
      new MutationObserver((_, o) => { if (!palette.isConnected) { window.__gone = performance.now(); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
    });
    await close();
    await page.getByTestId('search-palette').waitFor({ state: 'detached' });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => { window.__go = false; return { f: window.__f.slice(1), gone: window.__gone, l: window.__long.slice(window.__longStart).map((e) => e.dur) }; });
    // A frame belongs to the close if it started before the palette left the DOM.
    frames.push(...r.f.filter(([t, d]) => t - d <= r.gone).map(([, d]) => d)); after.push(...r.f.filter(([t, d]) => t - d > r.gone).map(([, d]) => d)); longs.push(...r.l);
    if (run === 0) {
      const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
      await cdp.send('Tracing.end');
      await done;
      await writeFile(`/tmp/j2/trace-${TAG}-${label}.json`, JSON.stringify({ traceEvents: traceChunks }));
    }
    await cdp.detach();
    await page.waitForTimeout(300);
  }
  frames.sort((a, b) => a - b);
  const pct = (p) => Math.round(frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] * 10) / 10;
  return { closeFrames: frames.length, p50: pct(0.5), p95: pct(0.95), max: Math.round(frames.at(-1) * 10) / 10, over16: frames.filter((f) => f > 16.7).length, afterCloseMax: Math.round(Math.max(0, ...after) * 10) / 10, longTasks: longs.map(Math.round) };
}

const results = { mode: HEADED ? 'headed' : 'headless', runs: RUNS };
results.escape = await measure('escape', () => page.keyboard.press('Escape'));
results.result = await measure('result', () => page.getByRole('option').filter({ hasText: /Pack/ }).first().click());
results.outside = await measure('outside', () => page.mouse.click(1300, 820));
await writeFile(`${OUT}/${TAG}-6-search-close.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
