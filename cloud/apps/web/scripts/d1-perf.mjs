// WP-D1 performance budget (Chromium, production build served by `vite preview` with the local API):
// long tasks while opening a menu and scrolling a 200-message chat, and idle per-frame JS.
import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5195';
const API = process.env.API ?? 'http://127.0.0.1:8821';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/D1`;
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.json();
};
await api('/v1/auth/dev', { method: 'POST', body: JSON.stringify({ type: 'auth.dev' }) });
const chat = await api('/v1/chats', { method: 'POST', body: JSON.stringify({ type: 'chat.input', title: 'Perf: 200 messages', pinned: false, mode: 'build' }) });
for (let i = 0; i < 100; i++) {
  const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ type: 'run.start', chatId: chat.id, text: `Message ${i + 1}: a realistic paragraph of user text so each bubble wraps across a line or two on narrow screens.`, script: i % 10 === 0 ? 'tools' : 'text' }) });
  for (let t = 0; t < 100; t++) {
    const { status } = await api(`/v1/runs/${run.id}`);
    if (!['queued', 'running'].includes(status)) break;
    await new Promise((r) => setTimeout(r, 30));
  }
}
let count = 0;
for (let cursor = ''; ; ) {
  const pageOf = await api(`/v1/chats/${chat.id}/messages?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  count += pageOf.items.length;
  if (!pageOf.nextCursor) break;
  cursor = pageOf.nextCursor;
}

const browser = await chromium.launch({ headless: !process.env.HEADED, args: process.env.HEADED ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
});
await page.goto(BASE);
await page.evaluate(() => fetch('/v1/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'auth.dev' }) }));
await page.goto(`${BASE}/c/${chat.id}`);
await page.getByTestId('assistant-turn').nth(20).waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
const rendered = await page.getByTestId('user-message-bubble').count();
const window_ = (name) => page.evaluate((n) => { window.__mark = window.__longTasks.length; return n; }, name);
const taken = () => page.evaluate(() => window.__longTasks.slice(window.__mark));

// 1. Scroll the whole chat top→bottom→top with wheel input.
await window_('scroll');
await page.mouse.move(820, 450);
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, -600); await page.waitForTimeout(16); }
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(16); }
const scrollTasks = await taken();
const frames = await page.evaluate(async () => {
  const el = document.querySelector('[data-testid="chat-scroll-viewport"]');
  const deltas = []; let last = performance.now();
  for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); const now = performance.now(); deltas.push(now - last); last = now; el.scrollTop = (Math.sin(i / 20) * 0.5 + 0.5) * (el.scrollHeight - el.clientHeight); }
  deltas.shift(); deltas.sort((a, b) => a - b);
  return { p50: deltas[Math.floor(deltas.length / 2)], p95: deltas[Math.floor(deltas.length * 0.95)] };
});

// 2. Open and close a menu five times (sidebar row actions).
await window_('menu');
const row = page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
for (let i = 0; i < 5; i++) {
  await row.hover();
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menu').waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
}
const menuTasks = await taken();

// 3. Composer tray and a 500-model list, paged like the real API: open, scroll to the end, back, close.
const catalog = Array.from({ length: 500 }, (_, i) => ({
  type: 'model', id: `perf-${i}`, providerId: 'scripted', displayName: `Perf model ${String(i + 1).padStart(3, '0')}`, tagline: 'A realistic tagline for this model',
  capabilities: { type: 'capabilities', tools: true, parallelToolCalls: true, vision: i % 2 === 0, documents: false, imagesInToolResults: false, reasoningEffort: i % 3 === 0, streamUsage: true, explicitPromptCaching: false, serverWebSearch: i % 4 === 0, midConversationSystem: false, serverCompaction: false, toolSearch: false },
  reasoningEfforts: ['low', 'medium', 'high'], pinned: i < 3, favorite: false,
}));
await page.route('**/v1/models?**', async (route) => {
  const query = new URL(route.request().url()).searchParams;
  const start = Number(query.get('cursor') ?? 0);
  const limit = Number(query.get('limit') ?? 50);
  await route.fulfill({ json: { type: 'page', items: catalog.slice(start, start + limit), nextCursor: start + limit < catalog.length ? String(start + limit) : null } });
});
await page.mouse.move(1300, 200);
await window_('tray');
for (let i = 0; i < 5; i++) {
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('plus-tray').waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.getByTestId('plus-tray').waitFor({ state: 'detached' });
}
const trayTasks = await taken();
await page.getByTestId('composer-plus-button').click();
await page.getByTestId('plus-tray').waitFor();
await window_('models');
let modelsLoaded = 0;
for (let i = 0; i < 3; i++) {
  await page.getByTestId('tray-model-picker-trigger').click();
  await page.getByRole('option').first().waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.getByRole('listbox', { name: 'Models' }).waitFor({ state: 'detached' });
}
await page.getByTestId('tray-model-picker-trigger').click();
await page.getByRole('option').first().waitFor();
const list = page.getByRole('listbox', { name: 'Models' });
const box = await list.boundingBox();
await page.mouse.move(box.x + 100, box.y + 100);
for (let i = 0; i < 240; i++) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(16);
  if (i % 40 === 39) await page.waitForTimeout(150);
}
const windowSize = await page.getByRole('option').count();
modelsLoaded = await list.evaluate((el) => Math.round(el.getBoundingClientRect().height / 56));
const modelTasks = await taken();
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.unroute('**/v1/models?**');

const scaled = value => value !== '' && value !== 'none' && value.split(' ').some(axis => Math.abs(Number(axis) - 1) > 0.001);

// 4. Liquid Glass stretch: press-drag each glass surface; no long tasks, the
// transform appears mid-drag and springs back to none on release.
await window_('stretch');
async function stretch(dragSelector, transformSelector, x, y) {
  const read = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return '';
      return getComputedStyle(el?.closest?.('[data-glass-surface]') ?? el).scale;
    }, sel);
  let mid = '';
  for (let attempt = 0; attempt < 3 && !scaled(mid); attempt++) {
    const box = await page.locator(dragSelector).boundingBox();
    await page.mouse.move(box.x + (x ?? box.width / 2), box.y + (y ?? box.height / 2));
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(box.x + box.width / 2 + (box.width / 2 + 96) * i / 24, box.y + box.height / 2 + i * 1.5);
      await page.waitForTimeout(16);
    }
    mid = await read(transformSelector);
    await page.mouse.up();
    // The spring clears its individual scale at rest; a fixed delay races this under load.
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return !el || getComputedStyle(el.closest('[data-glass-surface]') ?? el).scale === 'none';
    }, transformSelector, { timeout: 5000 });
  }
  return { mid, rest: await read(transformSelector) };
}
const stretchResults = {};
stretchResults.sidebar = await stretch('[data-testid="app-sidebar"] [data-testid="sidebar-new-chat"]', '[data-testid="app-sidebar"] [data-glass-surface]', 10, 10);
// Composer: start on the pill's bottom-left padding (not the textarea — typing keeps priority).
stretchResults.composer = await stretch('[data-testid="composer-surface"]', '[data-testid="composer-surface"]', 360, 48);
stretchResults.topbar = await stretch('[data-testid="nav-settings-button"]', '[data-testid="nav-settings-button"]', 10, 10);
// A row-menu open + stretch while open. A press-drag outside the items dismisses
// the menu by design, so only the mid-drag transform is asserted for menus.
await row.hover();
await row.getByRole('button', { name: /^Actions for/ }).click();
await page.getByRole('menu').waitFor();
await page.waitForFunction(() => document.querySelector('[role="menu"]')?.style.transform === '');
stretchResults.menu = await stretch('[role="menu"]', '[role="menu"] [data-glass-surface]', 40, 30);
await page.keyboard.press('Escape').catch(() => {});
await page.getByRole('menu').waitFor({ state: 'detached' }).catch(() => {});
const stretchTasks = await taken();
const { menu, ...rest } = stretchResults;
const menuStretchedOk = scaled(menu.mid);
const stretchOk = menuStretchedOk && Object.values(rest).every(
  (r) => scaled(r.mid) && r.rest === 'none',
);

// 5. Idle: count script callbacks per frame for 2 s (rAF loops would show up as scripting time).
const idle = await page.evaluate(async () => {
  let callbacks = 0;
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { callbacks++; return raf(cb); };
  await new Promise((r) => setTimeout(r, 2000));
  window.requestAnimationFrame = raf;
  return { rafCallbacksIn2s: callbacks, webglContexts: document.querySelectorAll('canvas').length };
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
await page.waitForTimeout(2000);
const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
await browser.close();

const result = {
  messagesInChat: count,
  userBubblesRendered: rendered,
  scroll: { longTasks: scrollTasks.length, maxLongTaskMs: Math.max(0, ...scrollTasks), frameMs: frames },
  menuOpen: { opens: 5, longTasks: menuTasks.length, maxLongTaskMs: Math.max(0, ...menuTasks) },
  trayOpen: { opens: 5, longTasks: trayTasks.length, maxLongTaskMs: Math.max(0, ...trayTasks) },
  modelList: { models: catalog.length, rowsLoaded: modelsLoaded, mountedOptions: windowSize, longTasks: modelTasks.length, maxLongTaskMs: Math.max(0, ...modelTasks) },
  stretch: { surfaces: stretchResults, longTasks: stretchTasks.length, maxLongTaskMs: Math.max(0, ...stretchTasks), ok: stretchOk },
  idle: { ...idle, scriptMsIn2s: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000 * 10) / 10, layoutsIn2s: after.LayoutCount - before.LayoutCount },
};
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/perf.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
const ok = result.scroll.maxLongTaskMs <= 50 && result.menuOpen.maxLongTaskMs <= 50 && result.trayOpen.maxLongTaskMs <= 50 && result.modelList.maxLongTaskMs <= 50 && result.stretch.maxLongTaskMs <= 50 && result.stretch.ok && result.idle.rafCallbacksIn2s === 0;
if (!ok) { console.error('PERF BUDGET FAILED'); process.exit(1); }
