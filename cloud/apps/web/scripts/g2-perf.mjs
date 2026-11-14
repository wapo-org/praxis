// WP-G2 performance: the morph at 120 Hz in headed Chromium with GPU, production build.
//   BASE=... API=... node apps/web/scripts/g2-perf.mjs   (HEADLESS=1 for headless)
// Measures a cold first open per session separately, then repeated open/close of each class, and fast toggling.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5231';
const HEADED = !process.env.HEADLESS;
const LAB = process.env.LAB ?? BASE;
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G2/perf-${HEADED ? 'headed' : 'headless'}.json`;
const browser = await chromium.launch({ headless: !HEADED, args: HEADED ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...(process.env.UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])] : [] });
const results = { mode: HEADED ? 'headed' : 'headless' };

async function session(base, path, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: HEADED ? 2 : 1 });
  await context.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  await page.request.post(`${base}/v1/auth/dev`, { data: { type: 'auth.dev' } });
  await page.goto(base + path);
  const dev = page.getByRole('button', { name: /local dev user/i });
  if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
  return { context, page };
}

async function measure(page, name, act) {
  await page.evaluate(() => {
    window.__mark = window.__longTasks.length;
    window.__frames = [];
    window.__moving = [];
    window.__recording = true;
    let last = performance.now();
    const tick = (now) => {
      if (!window.__recording) return;
      window.__frames.push(now - last);
      if (document.querySelector('[data-morphing]')) window.__moving.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const out = await page.evaluate(() => {
    window.__recording = false;
    const frames = window.__frames.slice(1).sort((a, b) => a - b);
    const stats = (list) => {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (p) => Math.round((sorted[Math.floor(sorted.length * p)] ?? 0) * 10) / 10;
      return { frames: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(0.9999) };
    };
    return { all: stats(frames), moving: stats(window.__moving.slice(1)), longTasks: window.__longTasks.slice(window.__mark) };
  });
  results[name] = out;
  console.log(name.padEnd(28), JSON.stringify(out));
}

const landed = (page) => page.waitForFunction(() => { const m = document.querySelector('[role=menu]'); return m && m.style.transform === ''; });
const gone = (page) => page.getByRole('menu').waitFor({ state: 'detached' });

// Lab scene, both classes over text.
// Cold first open, in repeated fresh sessions: this is where a map build or a first mount would show.
if (process.env.COLD) {
  const opens = {
    row: async (page) => {
      const row = page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
      await row.hover();
      return () => row.getByRole('button', { name: /^Actions for/ }).click();
    },
    tray: async (page) => () => page.getByTestId('composer-plus-button').click(),
  };
  for (const [kind, prepare] of Object.entries(opens)) {
    const runs = [];
    for (let i = 0; i < Number(process.env.COLD); i++) {
      const { context, page } = await session(BASE, '/');
      await page.getByTestId('chat-top-bar').waitFor();
      await page.waitForTimeout(1500);
      const press = await prepare(page);
      await measure(page, `cold ${kind} ${i}`, async () => {
        await press();
        await page.waitForTimeout(700);
      });
      runs.push(results[`cold ${kind} ${i}`]);
      await context.close();
    }
    results[`cold ${kind}`] = { maxFrame: Math.max(...runs.map((r) => r.moving.max)), p95: Math.max(...runs.map((r) => r.moving.p95)), longTasks: runs.flatMap((r) => r.longTasks) };
    console.log(`cold ${kind} over ${runs.length}`.padEnd(28), JSON.stringify(results[`cold ${kind}`]));
  }
  await writeFile(OUT, JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(0);
}

// The lab only exists in dev (LAB=''): run once against the dev server for these, once against a build for the app.
for (const id of process.env.NO_LAB ? [] : ['separate-top', 'attached-top']) {
  const { context, page } = await session(LAB, '/lab/glass?morph');
  const trigger = page.getByTestId(id);
  await trigger.waitFor();
  await page.waitForTimeout(1500); // idle warm-up happens here, as for a person arriving at the page
  await measure(page, `cold-first-open ${id}`, async () => {
    await trigger.click();
    await landed(page);
  });
  await page.keyboard.press('Escape');
  await gone(page);
  await page.waitForTimeout(400);
  await measure(page, `open ${id}`, async () => {
    for (let i = 0; i < 8; i++) {
      await trigger.click();
      await landed(page);
      await page.waitForTimeout(80);
      await page.keyboard.press('Escape');
      await gone(page);
      await page.waitForTimeout(120);
    }
  });
  await measure(page, `toggle-fast ${id}`, async () => {
    for (let i = 0; i < 24; i++) {
      await trigger.click();
      await page.waitForTimeout(60 + (i % 4) * 30);
    }
    await page.waitForTimeout(700);
  });
  await context.close();
}

// The real app: a chat row's menu and the composer tray over real content.
if (process.env.CHAT !== '') {
  const { context, page } = await session(BASE, process.env.CHAT ? `/c/${process.env.CHAT}` : '/');
  await page.getByTestId('chat-top-bar').waitFor();
  await page.waitForTimeout(1500);
  const row = page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
  await row.hover();
  await measure(page, 'cold-first-open row', async () => {
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await landed(page);
  });
  await page.keyboard.press('Escape');
  await gone(page);
  await measure(page, 'open row', async () => {
    for (let i = 0; i < 6; i++) {
      await row.hover();
      await row.getByRole('button', { name: /^Actions for/ }).click();
      await landed(page);
      await page.keyboard.press('Escape');
      await gone(page);
    }
  });
  await measure(page, 'cold-first-open tray', async () => {
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('plus-tray').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid=plus-tray]')?.parentElement?.style.transform === '');
  });
  await page.keyboard.press('Escape');
  await page.getByTestId('plus-tray').waitFor({ state: 'detached' });
  await measure(page, 'open tray', async () => {
    for (let i = 0; i < 6; i++) {
      await page.getByTestId('composer-plus-button').click();
      await page.getByTestId('plus-tray').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid=plus-tray]')?.parentElement?.style.transform === '');
      await page.keyboard.press('Escape');
      await page.getByTestId('plus-tray').waitFor({ state: 'detached' });
    }
  });
  await page.mouse.move(820, 450);
  await page.waitForTimeout(1500);
  results.idle = await page.evaluate(async () => {
    const counts = { raf: 0, styleWrites: 0 };
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { counts.raf += 1; return original(cb); };
    const observer = new MutationObserver((list) => { counts.styleWrites += list.length; });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'scale'] });
    await new Promise((r) => setTimeout(r, 2000));
    window.requestAnimationFrame = original;
    observer.disconnect();
    return counts;
  });
  console.log('idle (2 s)'.padEnd(28), JSON.stringify(results.idle));
  await context.close();
}
await writeFile(OUT, JSON.stringify(results, null, 2));
await browser.close();
