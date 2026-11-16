import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/K/K2`;
const ONLY = new Set((process.env.ONLY ?? 'fold,fade,perf').split(','));
await mkdir(`${OUT}/frames`, { recursive: true });

async function open({ scheme = 'light', reducedMotion = 'no-preference', headless = !!process.env.HEADLESS } = {}) {
  const browser = await chromium.launch({ headless, args: headless ? [] : ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion, serviceWorkers: 'block' });
  await context.addInitScript((mode) => localStorage.setItem('praxis-theme', mode), scheme);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(async (mode) => { const { apiClient } = await import('/src/lib/api.ts'); await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field: 'theme', value: mode }) }).catch(() => {}); }, scheme).catch(() => {});
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor();
  await page.waitForTimeout(500);
  return { browser, page };
}

/** Sends through the composer, so the live run renders exactly as a user sees it. */
async function startRun(page, text, script, streamSim) {
  await page.evaluate(({ script, streamSim }) => {
    window.__k2Script = { script, streamSim };
  }, { script, streamSim });
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() ?? '{}');
    const extra = await page.evaluate(() => window.__k2Script);
    await route.continue({ postData: JSON.stringify({ ...body, providerId: 'scripted', modelId: 'scripted', ...extra }) });
  });
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
}

function strip(files, out, cols = 6) {
  execFileSync('python3', ['-c', `
import sys
from PIL import Image
files=sys.argv[2:]; cols=int(sys.argv[1])
ims=[Image.open(f).convert('RGB') for f in files]
w,h=ims[0].size; rows=(len(ims)+cols-1)//cols
board=Image.new('RGB',(w*cols,h*rows),(255,255,255))
for i,im in enumerate(ims): board.paste(im,((i%cols)*w,(i//cols)*h))
board.save('${out}')
`, String(cols), ...files]);
}

if (ONLY.has('fold')) {
  const { browser, page } = await open();
  await startRun(page, 'Interpret the financial reports', 'streamSim', { speed: '40tps', chunkSize: 'word', reasoningShape: 'summary', sample: 'torture' });
  // CSS transitions at 1/10 speed so a screenshot every ~100 ms is a real frame of the fold; streaming is JS-paced.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  const turn = page.getByTestId('live-run-streaming-turn');
  await page.getByTestId('reasoning-peek').waitFor({ timeout: 20000 });
  const files = []; const log = [];
  const t0 = Date.now();
  let closedAt = null;
  for (let i = 0; i < 400 && (closedAt === null || Date.now() - closedAt < 4200); i++) {
    // No auto-wait: the live turn hands over to the saved message when the run ends.
    const box = await page.evaluate(() => { const el = [...document.querySelectorAll('[data-testid="live-run-streaming-turn"],[data-testid="assistant-turn"]')].at(-1); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    if (!box) break;
    const state = await page.evaluate(() => {
      const fold = document.querySelector('[data-testid="agent-activity-peek"]');
      const h = fold?.getBoundingClientRect().height ?? 0;
      return { open: fold?.getAttribute('data-open'), h: Math.round(h * 10) / 10, toggle: document.querySelector('[data-testid="agent-activity-toggle"]')?.textContent };
    });
    if (state.open === 'false' && closedAt === null) closedAt = Date.now();
    if (closedAt !== null || i % 6 === 0) {
      const f = `${OUT}/frames/fold-${String(files.length).padStart(3, '0')}.png`;
      await page.screenshot({ path: f, clip: { x: box.x - 16, y: box.y - 16, width: Math.min(box.width + 32, 700), height: 300 } });
      files.push(f); log.push({ t: Date.now() - t0, ...state });
    }
    await page.waitForTimeout(40);
  }
  await writeFile(`${OUT}/after-1-fold-frames.json`, JSON.stringify(log, null, 2));
  // From two frames before the fold starts closing.
  const start = Math.max(0, log.findIndex((l) => l.open === 'false') - 2);
  strip(files.slice(start, start + 18), `${OUT}/after-1-fold-strip.png`, 6);
  console.log('fold frames', log.slice(-18).map((l) => `${l.t}ms open=${l.open} h=${l.h}`).join(' | '));
  await page.waitForTimeout(3000);
  await browser.close();
}

if (ONLY.has('fade')) for (const scheme of ['light', 'dark']) {
  const { browser, page } = await open({ scheme });
  await startRun(page, 'Write a long answer', 'long', undefined);
  const files = []; const log = []; const t0 = Date.now();
  let endAt = null;
  for (let i = 0; i < 600; i++) {
    const s = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="run-backdrop"]');
      return { present: !!el, opacity: el ? Number(getComputedStyle(el).opacity).toFixed(3) : '0', running: !!document.querySelector('[data-testid="composer-stop-button"]') };
    });
    const t = Date.now() - t0;
    if (!s.running && t > 1500 && endAt === null) endAt = t;
    const inFade = t < 1100 || (endAt !== null && t - endAt < 1400);
    if (inFade && i % 2 === 0) {
      const f = `${OUT}/frames/fade-${scheme}-${String(files.length).padStart(3, '0')}.png`;
      await page.screenshot({ path: f, clip: { x: 300, y: 120, width: 1100, height: 620 }, scale: 'css' });
      files.push(f); log.push({ t, ...s });
    }
    if (endAt !== null && t - endAt > 1500) break;
    await page.waitForTimeout(30);
  }
  await writeFile(`${OUT}/after-9-fade-${scheme}.json`, JSON.stringify(log, null, 2));
  strip(files.slice(0, 12), `${OUT}/after-9-fade-in-${scheme}.png`, 6);
  strip(files.slice(-12), `${OUT}/after-9-fade-out-${scheme}.png`, 6);
  console.log('fade', scheme, log.map((l) => `${l.t}:${l.opacity}`).join(' '));
  await browser.close();
}

if (ONLY.has('perf')) {
  const results = {};
  for (const [label, reducedMotion] of [['background-on', 'no-preference'], ['background-off', 'reduce']]) {
    const { browser, page } = await open({ reducedMotion });
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (now) => { window.__frames.push(now - last); last = now; window.__raf = requestAnimationFrame(tick); };
      window.__raf = requestAnimationFrame(tick);
      window.__long = 0;
      new PerformanceObserver((l) => { window.__long += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
    });
    await startRun(page, 'Write a long answer', 'long', undefined);
    await page.getByTestId('composer-stop-button').waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__frames = []; window.__long = 0; });
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => {
      const f = window.__frames.slice(1).sort((a, b) => a - b);
      const q = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
      return { frames: f.length, mean: f.reduce((a, b) => a + b, 0) / f.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: f.at(-1), over20ms: f.filter((x) => x > 20).length, longTasks: window.__long, backdrop: !!document.querySelector('[data-testid="run-backdrop"]'), streaming: !!document.querySelector('[data-testid="composer-stop-button"]') };
    });
    results[label] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));
    console.log(label, results[label]);
    await browser.close();
  }
  results.mode = process.env.HEADLESS ? 'headless' : 'headed';
  await writeFile(`${OUT}/after-9-perf-${results.mode}.json`, JSON.stringify(results, null, 2));
}
