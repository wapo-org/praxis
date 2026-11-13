// WP-M1 capture: every frame of a send (from the empty state and inside a chat) and of a chat switch, from
// headless Chromium's screencast. Each frame carries its true time since the key press as a barcode drawn in
// the same rAF as the page, and a per-frame sampler records what is on screen (bubble rects, empty state,
// Working row, stop button) for the measured numbers.
// Needs the M1 harness (m1-server.ts) + Vite. Run from cloud/:
//   BASE=http://127.0.0.1:5261 API=http://127.0.0.1:8891 OUT=<dir> node apps/web/scripts/m1-capture.mjs [new|existing|switch]...
import { chromium, webkit } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5261';
const API = process.env.API ?? 'http://127.0.0.1:8891';
const OUT = process.env.OUT ?? '/tmp/m1-capture';
const ENGINE = process.env.ENGINE ?? 'chromium';
const PROMPT = 'write something semi long';
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);

async function open(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', recordVideo: { dir: `${OUT}/video-${ENGINE}`, size: { width: 1440, height: 900 } } });
  await context.addInitScript(() => localStorage.setItem('praxis-theme', 'dark'));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  await page.evaluate(async (u) => { await (await import('/src/lib/dev-auth.ts')).devAuth(u); }, user);
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  // The owner's setup: two remote MCP connectors (the harness gives them network latency).
  await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    for (const name of ['exa', 'firecrawl']) {
      await apiClient.setConsent(`${name}.mcp.test`, true);
      await apiClient.request('/v1/connectors', { method: 'POST', body: JSON.stringify({ type: 'connector.input', name: name[0].toUpperCase() + name.slice(1), url: `https://${name}.mcp.test/mcp`, trusted: true }) });
    }
  });
  return { context, page };
}

const cold = (user) => fetch(`${API}/__test/m1/cold`, { method: 'POST', body: JSON.stringify({ userId: user }), headers: { 'content-type': 'application/json' } }).then((r) => r.json());

/** Barcode clock (14 bits of ms since the last arm) + per-frame sampler. */
async function instrument(page) {
  await page.evaluate(() => {
    if (window.__m1) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;bottom:0;display:flex;z-index:2147483647;pointer-events:none';
    const bits = Array.from({ length: 16 }, () => { const b = document.createElement('i'); b.style.cssText = 'display:block;width:8px;height:8px;background:#000'; bar.appendChild(b); return b; });
    document.body.appendChild(bar);
    const m1 = (window.__m1 = { mark: 0, armed: false, samples: [] });
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const opacity = (el) => { let o = 1; for (let n = el; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (s.visibility === 'hidden' || s.display === 'none') return 0; o *= Number(s.opacity); } return Math.round(o * 100) / 100; };
    m1.arm = () => { m1.mark = performance.now(); m1.armed = true; m1.samples = []; };
    const tick = (now) => {
      const t = Math.max(0, Math.min(16383, Math.round(now - m1.mark)));
      bits[0].style.background = m1.armed ? '#fff' : '#000';
      bits[15].style.background = '#fff';
      for (let i = 0; i < 14; i++) bits[i + 1].style.background = t & (1 << (13 - i)) ? '#fff' : '#000';
      if (m1.armed) {
        const flight = document.querySelector('[data-testid="send-flight-bubble"]');
        const bubbles = document.querySelectorAll('[data-testid="user-message-bubble"] [data-user-bubble]');
        const bubble = bubbles[bubbles.length - 1];
        const empty = document.querySelector('[data-testid="chat-empty-state"]');
        const live = document.querySelector('[data-testid="live-run-streaming-turn"]');
        const stop = document.querySelector('[aria-label="Stop generating"]');
        const rows = [...document.querySelectorAll('[data-chat-column] > [data-message-key]')].slice(0, 12).map((el) => ({ key: el.dataset.messageKey, o: Math.round(Number(getComputedStyle(el).opacity) * 100) / 100, y: Math.round(new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform).m42 * 10) / 10, top: Math.round(el.getBoundingClientRect().top) }));
        m1.samples.push({
          t, path: location.pathname,
          flight: flight ? rect(flight) : null,
          bubble: bubble ? { ...rect(bubble), o: opacity(bubble), n: bubbles.length } : null,
          empty: empty ? { ...rect(empty), o: opacity(empty) } : null,
          live: live ? { o: opacity(live), text: live.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) } : null,
          stop: !!stop,
          title: document.querySelector('[data-testid="chat-top-bar"]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60),
          rows,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.addEventListener('keydown', (e) => { if (e.key === 'Enter') m1.arm(); }, { capture: true });
  });
}

async function record(page, dir, run) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (ENGINE !== 'chromium') { await run(); return 0; }
  const cdp = await page.context().newCDPSession(page);
  let count = 0;
  const writes = [];
  cdp.on('Page.screencastFrame', async (event) => {
    writes.push(writeFile(`${dir}/f-${String(count++).padStart(4, '0')}.jpg`, Buffer.from(event.data, 'base64')));
    await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, maxWidth: 1440, maxHeight: 900 });
  await page.waitForTimeout(150);
  await run();
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await cdp.detach();
  return count;
}

/** The numbers the owner's capture is judged by. */
function sendMetrics(samples) {
  const first = (pred) => samples.find(pred)?.t ?? null;
  const visibleBubble = (s) => (s.flight && s.flight.w > 0) || (s.bubble && s.bubble.o > 0.05);
  const appeared = first(visibleBubble);
  const gone = samples.filter((s) => appeared !== null && s.t > appeared && !visibleBubble(s)).map((s) => s.t);
  const overlap = samples.filter((s) => s.flight && s.empty && s.empty.o > 0.05 && s.flight.x < s.empty.x + s.empty.w && s.flight.x + s.flight.w > s.empty.x && s.flight.y < s.empty.y + s.empty.h && s.flight.y + s.flight.h > s.empty.y).map((s) => s.t);
  const emptyWithBubble = samples.filter((s) => s.empty && s.empty.o > 0.05 && ((s.flight && s.flight.w > 0) || (s.bubble && s.bubble.o > 0.05))).map((s) => s.t);
  // Vertical direction changes of the flying bubble (its single overshoot near the end is one reversal).
  const ys = samples.filter((s) => s.flight).map((s) => s.flight.y);
  let reversals = 0, dir = 0;
  for (let i = 1; i < ys.length; i++) { const d = Math.sign(ys[i] - ys[i - 1]); if (Math.abs(ys[i] - ys[i - 1]) >= 2 && d && dir && d !== dir) reversals++; if (Math.abs(ys[i] - ys[i - 1]) >= 2 && d) dir = d; }
  const jumps = []; for (let i = 1; i < ys.length; i++) if (Math.abs(ys[i] - ys[i - 1]) > 120) jumps.push(ys[i] - ys[i - 1]);
  const flightEnd = samples.filter((s) => s.flight).at(-1);
  const landed = samples.find((s) => flightEnd && s.t > flightEnd.t && s.bubble && s.bubble.o > 0.05);
  const working = samples.find((s) => s.live && s.live.o > 0.05 && /Working/.test(s.live.text));
  return {
    frames: samples.length,
    bubbleAppearedMs: appeared,
    bubbleGoneFrames: gone.length, bubbleGoneFirstMs: gone[0] ?? null, bubbleGoneLastMs: gone.at(-1) ?? null,
    flightOverEmptyStateFrames: overlap.length,
    emptyStateWithBubbleFrames: emptyWithBubble.length, emptyStateLastMs: samples.filter((s) => s.empty && s.empty.o > 0.05).at(-1)?.t ?? null,
    flightVerticalReversals: reversals, flightJumpsOver120px: jumps,
    flightLastRect: flightEnd?.flight ?? null, bubbleRectAfterLanding: landed ? { x: landed.bubble.x, y: landed.bubble.y, w: landed.bubble.w, h: landed.bubble.h } : null,
    workingRowMs: working?.t ?? null, workingRowFirstText: working?.live.text ?? null,
    stopButtonMs: first((s) => s.stop),
    pathChangedMs: first((s) => s.path !== samples[0]?.path),
  };
}

async function send(page, dir, text, { waitWorking = true } = {}) {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await page.waitForTimeout(300);
  const frames = await record(page, `${dir}/frames`, async () => {
    await input.press('Enter');
    if (waitWorking) await page.getByTestId('live-run-streaming-turn').getByText(/Working/).first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
  });
  const samples = await page.evaluate(() => { window.__m1.armed = false; return window.__m1.samples; });
  await writeFile(`${dir}/samples.json`, JSON.stringify(samples));
  const metrics = sendMetrics(samples);
  await writeFile(`${dir}/metrics.json`, JSON.stringify({ engine: ENGINE, screencastFrames: frames, ...metrics }, null, 1));
  console.log(dir, JSON.stringify(metrics));
  return metrics;
}

async function finish(page) {
  // Let the run end (or stop it) so the next send starts clean.
  const stop = page.getByRole('button', { name: 'Stop generating' });
  if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
}

const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  const user = `wp-m1-${ENGINE}-${Date.now()}`;
  const { context, page } = await open(browser, user);
  await instrument(page);
  if (want('new') || want('existing')) {
    await cold(user);
    await send(page, `${OUT}/${ENGINE}-new`, PROMPT);
    await finish(page);
    if (want('existing')) {
      await cold(user);
      await instrument(page);
      await send(page, `${OUT}/${ENGINE}-existing`, PROMPT);
      await finish(page);
    }
  }
  if (want('switch')) {
    // Two chats with history: switch between them from the sidebar.
    const make = async (label) => {
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true, shiftKey: true })));
      await page.waitForURL((u) => new URL(u).pathname === '/');
      for (let i = 0; i < 4; i++) {
        await page.getByTestId('composer-input').fill(`${label} message ${i + 1}: a short plain question`);
        await page.getByTestId('composer-input').press('Enter');
        await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]') && !document.querySelector('[data-testid="live-run-streaming-turn"]'), null, { timeout: 30000 });
      }
      return new URL(page.url()).pathname;
    };
    const a = await make('Alpha');
    const b = await make('Bravo');
    await page.waitForTimeout(800);
    const dir = `${OUT}/${ENGINE}-switch`;
    const clickChat = (label) => page.getByRole('complementary', { name: 'Conversation history' }).getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
    const takes = {};
    const frames = await record(page, `${dir}/frames`, async () => {
      await page.evaluate(() => window.__m1.arm());
      await clickChat('Alpha');
      await page.waitForTimeout(700);
      takes.switch = await page.evaluate(() => window.__m1.samples);
      await page.evaluate(() => window.__m1.arm());
      await clickChat('Alpha'); // the same chat again: no replay
      await page.waitForTimeout(500);
      takes.same = await page.evaluate(() => window.__m1.samples);
    });
    await page.evaluate(() => { window.__m1.armed = false; });
    const rowsAt = (samples) => samples.map((s) => ({ t: s.t, path: s.path, rows: s.rows.map((r) => `${r.key.slice(0, 10)} o=${r.o} y=${r.y} top=${r.top}`) }));
    await writeFile(`${dir}/samples.json`, JSON.stringify({ switch: rowsAt(takes.switch), same: rowsAt(takes.same) }, null, 1));
    const animated = (samples) => new Set(samples.flatMap((s) => s.rows.filter((r) => r.o < 0.99 || Math.abs(r.y) > 0.5).map((r) => r.key))).size;
    await writeFile(`${dir}/metrics.json`, JSON.stringify({ from: b, to: a, screencastFrames: frames, switchAnimatedRows: animated(takes.switch), sameChatAnimatedRows: animated(takes.same), switchRowCount: takes.switch.at(-1)?.rows.length }, null, 1));
    console.log(dir, 'frames', frames, 'from', b, 'to', a);
  }
  await context.close();
} finally {
  await browser.close();
}
