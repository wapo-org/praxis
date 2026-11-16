import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';
const API = process.env.API ?? 'http://127.0.0.1:8824';
const HEADED = !!process.env.HEADED;
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G1/perf-${HEADED ? 'headed' : 'headless'}.json`;
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.json();
};
await api('/v1/auth/dev', { method: 'POST', body: JSON.stringify({ type: 'auth.dev' }) });
let chatId = process.env.CHAT;
if (!chatId) {
  const chat = await api('/v1/chats', { method: 'POST', body: JSON.stringify({ type: 'chat.input', title: 'Perf: 220 messages', pinned: false, mode: 'build' }) });
  chatId = chat.id;
  for (let i = 0; i < 110; i++) {
    const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ type: 'run.start', chatId, text: `Message ${i + 1}: a realistic paragraph of user text so each bubble wraps across a line or two on narrow screens.`, script: i % 10 === 0 ? 'tools' : 'text' }) });
    for (let t = 0; t < 100; t++) {
      const { status } = await api(`/v1/runs/${run.id}`);
      if (!['queued', 'running'].includes(status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  console.log('chat', chatId);
}
const browser = await chromium.launch({ headless: !HEADED, args: HEADED ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...(process.env.UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])] : [] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: HEADED ? 2 : 1 })).newPage();
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
});
await page.goto(BASE);
await page.evaluate(() => fetch('/v1/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'auth.dev' }) }));
await page.goto(`${BASE}/c/${chatId}`);
await page.getByTestId('assistant-turn').nth(20).waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
const rendered = await page.getByTestId('user-message-bubble').count();
const results = { mode: HEADED ? 'headed' : 'headless', rendered };

/** Run `act` while recording rAF deltas and long tasks. */
async function measure(name, act) {
  await page.evaluate(() => {
    window.__mark = window.__longTasks.length;
    window.__frames = [];
    window.__recording = true;
    let last = performance.now();
    const tick = (now) => {
      if (!window.__recording) return;
      window.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const out = await page.evaluate(() => {
    window.__recording = false;
    const frames = window.__frames.slice(1).sort((a, b) => a - b);
    const at = (p) => Math.round((frames[Math.floor(frames.length * p)] ?? 0) * 10) / 10;
    return { frames: frames.length, p50: at(0.5), p95: at(0.95), max: Math.round((frames[frames.length - 1] ?? 0) * 10) / 10, longTasks: window.__longTasks.slice(window.__mark) };
  });
  results[name] = out;
  console.log(name.padEnd(22), JSON.stringify(out));
}

await measure('scroll', async () => {
  await page.mouse.move(820, 450);
  for (let i = 0; i < 80; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(16); }
  for (let i = 0; i < 80; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(16); }
});
await page.waitForTimeout(400);
await measure('scroll-programmatic', () => page.evaluate(async () => {
  const el = document.querySelector('[data-testid="chat-scroll-viewport"]');
  for (let i = 0; i < 180; i++) { await new Promise(requestAnimationFrame); el.scrollTop = (Math.sin(i / 24) * 0.5 + 0.5) * (el.scrollHeight - el.clientHeight); }
}));
await page.waitForTimeout(400);
const row = page.locator('[data-testid="app-sidebar"] [data-sidebar-row]').first();
await measure('menu-open', async () => {
  for (let i = 0; i < 4; i++) {
    await row.hover();
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menu').waitFor();
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
  }
});
await measure('tray-open', async () => {
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('plus-tray').waitFor();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.getByTestId('plus-tray').waitFor({ state: 'detached' });
  }
});
await measure('sidebar-collapse', async () => {
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('sidebar-toggle').click();
    await page.waitForTimeout(650);
    await page.getByTestId('nav-sidebar-button').click();
    await page.waitForTimeout(650);
  }
});
const stretch = (locator) => async () => {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(x + i * 3, y - i); await page.waitForTimeout(12); }
  for (let i = 40; i >= 0; i--) { await page.mouse.move(x + i * 3, y - i); await page.waitForTimeout(12); }
  await page.mouse.move(x + 90, y + 30);
  await page.mouse.up();
  await page.waitForTimeout(1000);
};
await measure('stretch-sidebar', stretch(page.getByTestId('sidebar-account')));
await measure('stretch-composer', stretch(page.getByTestId('composer-input')));
await measure('stretch-title', stretch(page.getByTestId('nav-chat-title-pill')));
await measure('stretch-cluster', stretch(page.getByTestId('nav-settings-button')));
await page.getByTestId('composer-plus-button').click();
await page.getByTestId('plus-tray').waitFor();
await page.waitForTimeout(400);
await measure('stretch-tray', stretch(page.getByTestId('plus-tray')));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
// Idle: nothing may run per frame (pending framer frames, loops).
await page.mouse.move(820, 450);
await page.waitForTimeout(1500);
results.idle = await page.evaluate(async () => {
  const counts = { raf: 0, styleWrites: 0 };
  const originalRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { counts.raf += 1; return originalRaf(cb); };
  const observer = new MutationObserver((list) => { counts.styleWrites += list.length; });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'scale'] });
  await new Promise((r) => setTimeout(r, 2000));
  window.requestAnimationFrame = originalRaf;
  observer.disconnect();
  return counts;
});
console.log('idle (2 s)'.padEnd(22), JSON.stringify(results.idle));
await writeFile(OUT, JSON.stringify(results, null, 2));
await browser.close();
