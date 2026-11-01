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

const browser = await chromium.launch();
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
const row = page.locator('[data-testid="app-sidebar"] .screen-history-row').first();
for (let i = 0; i < 5; i++) {
  await row.hover();
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menu').waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
}
const menuTasks = await taken();

// 3. Idle: count script callbacks per frame for 2 s (rAF loops would show up as scripting time).
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
  idle: { ...idle, scriptMsIn2s: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000 * 10) / 10, layoutsIn2s: after.LayoutCount - before.LayoutCount },
};
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/perf.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
const ok = result.scroll.maxLongTaskMs <= 50 && result.menuOpen.maxLongTaskMs <= 50 && result.idle.rafCallbacksIn2s === 0;
if (!ok) { console.error('PERF BUDGET FAILED'); process.exit(1); }
