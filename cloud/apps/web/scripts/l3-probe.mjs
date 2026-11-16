import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { OUT, TAG, chat, open, quantile, round, send } from './l3-lib.mjs';

const ONLY = new Set((process.env.ONLY ?? 'latency,layout,strip,scroll').split(','));
const PROMPT = process.env.STRESS === '1' ? 'write something long for formatting test extended' : 'write something long for formatting test';
await mkdir(OUT, { recursive: true });
const { OWNER_DOC } = await import('./l3-fixtures.ts').catch(async () => {
  // Plain node cannot import TypeScript before 22.18; read the template literal instead.
  const source = await (await import('node:fs/promises')).readFile(new URL('./l3-fixtures.ts', import.meta.url), 'utf8');
  const body = /export const OWNER_DOC = `([\s\S]*?)`;\n/.exec(source)[1];
  return { OWNER_DOC: body.replace(/\\`/g, '`').replace(/\\\$/g, '$') };
});

/** Words that occur once in the answer and are shown as text (not inside a URL, an HTML tag or a fence's info string). */
function probeWords(doc) {
  const masked = doc.replace(/\]\([^)]*\)/g, (m) => ' '.repeat(m.length)).replace(/<[^>\n]*>/g, (m) => ' '.repeat(m.length)).replace(/^\s*```.*$/gm, (m) => ' '.repeat(m.length)).replace(/https?:\S+/g, (m) => ' '.repeat(m.length));
  const out = [];
  // Once as a substring of the whole source, so `includes` cannot match an earlier, longer word.
  for (const m of masked.matchAll(/[A-Za-z]{6,}/g)) if (doc.split(m[0]).length === 2) out.push({ word: m[0], end: m.index + m[0].length });
  return out;
}

/** In the page: record when each text delta arrives (a tee of the run's event stream) and what each frame shows. */
function instrument(page, probes) {
  return page.addInitScript((probes) => {
    const l3 = (window.__l3 = { probes: probes.map((p) => ({ ...p })), text: '', arrivals: [], chunks: 0, frames: [], mutations: 0, shifts: 0, shiftEntries: 0, layout: [], mode: 'latency', running: false });
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = String(args[0]?.url ?? args[0]);
      if (!/\/v1\/runs\/[^/]+\/events/.test(url) || !response.body) return response;
      const [app, probe] = response.body.tee();
      void (async () => {
        const reader = probe.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const now = performance.now();
          buffer += decoder.decode(value, { stream: true });
          let at;
          while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
            const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            try {
              const event = JSON.parse(data).event;
              if (event?.type === 'text.delta') {
                l3.firstAt ??= now;
                l3.text += event.text;
                l3.chunks += 1;
                l3.arrivals.push([now, l3.text.length]);
                for (const p of l3.probes) if (p.arrivedAt === undefined && l3.text.length >= p.end) p.arrivedAt = now;
              }
              if (event?.type === 'run.finished') { l3.finishedAt = now; for (const p of l3.probes) p.arrivedAt ??= now; }
            } catch { /* keepalive */ }
          }
        }
      })();
      return new Response(app, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (l3.running && !entry.hadRecentInput) { l3.shifts += entry.value; l3.shiftEntries += 1; } }).observe({ type: 'layout-shift', buffered: false });
    } catch { /* not Chromium */ }
    const LEAVES = 'p,h1,h2,h3,h4,h5,h6,li,pre,tr,blockquote,hr';
    const SOLID = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'HR']);
    let last = 0, previous = null, observed = null;
    const observer = new MutationObserver(() => { l3.mutations += 1; });
    const tick = (now) => {
      if (l3.running) {
        if (last) l3.frames.push(now - last);
        const views = document.querySelectorAll('[data-testid="agent-message-view"]');
        const view = views[views.length - 1];
        if (view) {
          if (observed !== view) { observer.disconnect(); observer.observe(view, { subtree: true, childList: true, characterData: true }); observed = view; }
          const text = view.textContent ?? '';
          l3.shown = text.length;
          for (const p of l3.probes) if (p.paintedAt === undefined && text.includes(p.word)) p.paintedAt = now;
          if (l3.mode === 'layout') {
            const origin = view.getBoundingClientRect().top;
            const els = [...view.querySelectorAll(LEAVES)].filter(el => !el.closest('section[data-footnotes]'));
            const now_ = new Map(els.map((el) => { const r = el.getBoundingClientRect(); return [el, [el.tagName, r.top - origin, r.height]]; }));
            if (previous && l3.lastView === view) {
              let moved = 0, resized = 0;
              const detail = [];
              const writing = previous.last;
              for (const [el, was] of previous.map) {
                const is = now_.get(el);
                if (!is || el === writing || el.contains(writing)) continue;
                const dy = is[1] - was[1], dh = is[2] - was[2];
                if ((Math.abs(dy) > 0.5 || (SOLID.has(is[0]) && Math.abs(dh) > 0.5)) && detail.length < 6) detail.push([is[0], (el.textContent ?? '').slice(0, 24), Math.round(dy), Math.round(dh)]);
                moved += Math.abs(dy);
                if (SOLID.has(is[0])) resized += Math.abs(dh);
              }
              if (moved > 0.5 || resized > 0.5) l3.layout.push({ at: now, moved, resized, after: l3.finishedAt !== undefined, leaves: els.length, detail });
            }
            if (previous && l3.lastView !== view) {
              l3.viewSwaps = (l3.viewSwaps ?? 0) + 1;
              const before = [...previous.map];
              let moved = 0, resized = 0;
              for (let i = 0; i < Math.min(before.length, els.length); i++) {
                const [oldElement, was] = before[i];
                const element = els[i];
                const current = now_.get(element);
                if (oldElement.tagName !== element.tagName || oldElement.textContent !== element.textContent) continue;
                moved += Math.abs(current[1] - was[1]);
                resized += Math.abs(current[2] - was[2]);
              }
              if (moved > 0.5 || resized > 0.5) l3.layout.push({ at: now, moved, resized, after: true, detail: ['live-to-saved view swap'] });
            }
            previous = { map: now_, last: els[els.length - 1] }; l3.lastView = view;
          }
        }
      }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, probes);
}

async function stream(mode, browserType = chromium) {
  const probes = probeWords(OWNER_DOC);
  const { browser, page } = await open(browserType, { dpr: 1 });
  await instrument(page, probes);
  await chat(page, { model: 'l3-80-150', title: `L3 ${mode}` });
  const cdp = browserType === chromium ? await page.context().newCDPSession(page) : null;
  await cdp?.send('Performance.enable');
  const metrics = async () => Object.fromEntries(((await cdp?.send('Performance.getMetrics'))?.metrics ?? []).map((m) => [m.name, m.value]));
  await page.evaluate((mode) => { window.__l3.mode = mode; window.__l3.running = true; }, mode);
  const before = await metrics();
  await send(page, PROMPT);
  await page.waitForFunction(() => window.__l3.finishedAt !== undefined, null, { timeout: 120000 });
  const after = await metrics();
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => { const l3 = window.__l3; l3.running = false; return l3; });
  await browser.close();
  return { data, cpu: cdp ? { scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000 } : null };
}

if (ONLY.has('latency')) {
  const { data, cpu } = await stream('latency');
  const streamMs = data.finishedAt - data.firstAt;
  const lat = data.probes.filter((p) => p.arrivedAt !== undefined).map((p) => ({ word: p.word, ms: p.paintedAt === undefined ? null : p.paintedAt - p.arrivedAt, heldUntilEnd: p.paintedAt !== undefined && p.paintedAt >= data.finishedAt - 20 && p.arrivedAt < data.finishedAt - 500 }));
  const painted = lat.filter((l) => l.ms !== null).map((l) => l.ms);
  const worst = [...lat].sort((a, b) => (b.ms ?? 1e9) - (a.ms ?? 1e9)).slice(0, 8);
  const frames = data.frames;
  const summary = {
    tag: TAG, fixture: process.env.STRESS === '1' ? 'OWNER_DOC + extended prose' : 'OWNER_DOC', measurement: 'First animation frame with the sampled word in DOM text, measured from receipt of its final source character.', chars: data.text.length, chunks: data.chunks, streamMs: round(streamMs), tokensPerSecond: round(data.chunks / (streamMs / 1000)),
    chunkToPaintMs: { p50: round(quantile(painted, 0.5)), p95: round(quantile(painted, 0.95)), max: round(Math.max(...painted)), probes: lat.length, neverPainted: lat.filter((l) => l.ms === null).map((l) => l.word), over100ms: painted.filter((ms) => ms > 100).length, over1000ms: painted.filter((ms) => ms > 1000).length, heldUntilRunEnd: lat.filter((l) => l.heldUntilEnd).length },
    worst: worst.map((w) => ({ word: w.word, ms: round(w.ms) })),
    frameMs: { p50: round(quantile(frames, 0.5)), p95: round(quantile(frames, 0.95)), p99: round(quantile(frames, 0.99)), max: round(Math.max(...frames)), over20ms: frames.filter((f) => f > 20).length, over34ms: frames.filter((f) => f > 34).length, frames: frames.length },
    domMutationBatches: data.mutations, mutationBatchesPerChunk: round(data.mutations / data.chunks, 2),
    mainThread: cpu && { ...Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, round(v)])), scriptMsPerChunk: round(cpu.scriptMs / data.chunks, 2), taskMsPerChunk: round(cpu.taskMs / data.chunks, 2) },
    layoutShiftScore: round(data.shifts, 4), layoutShiftEntries: data.shiftEntries,
  };
  await writeFile(`${OUT}/${TAG}-stream-latency.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (ONLY.has('layout')) {
  const { data } = await stream('layout');
  const during = data.layout.filter((e) => !e.after), atEnd = data.layout.filter((e) => e.after);
  const sum = (list, key) => round(list.reduce((a, e) => a + e[key], 0));
  const summary = { tag: TAG, liveToSavedSwaps: data.viewSwaps ?? 0, note: 'Positions are relative to the message, so scrolling does not count. moved = Σ|Δtop| of blocks that already existed (by element identity, excluding the one being written and its ancestors); resized = Σ|Δheight| of those blocks. Generated footnotes stay below the growing document and are excluded. A swap of the live view for the saved one is compared by position in at-finish.',
    whileStreaming: { framesWithReflow: during.length, movedPx: sum(during, 'moved'), resizedPx: sum(during, 'resized') },
    atFinish: { framesWithReflow: atEnd.length, movedPx: sum(atEnd, 'moved'), resizedPx: sum(atEnd, 'resized') },
    events: data.layout.slice(0, 40).map((e) => ({ atMs: round(e.at - data.firstAt), moved: round(e.moved), resized: round(e.resized), after: e.after, leaves: e.leaves, detail: e.detail })) };
  await writeFile(`${OUT}/${TAG}-stream-layout.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, events: summary.events.length }, null, 2));
}

if (ONLY.has('strip')) {
  // Frames of the same stream at fixed times after the first token, for a strip (composed by l3-strip.py).
  const { browser, page } = await open(chromium, { dpr: 1, width: 1280, height: 800 });
  await instrument(page, []);
  await chat(page, { model: 'l3-80-150', title: 'L3 strip' });
  await mkdir(`${OUT}/${TAG}-strip`, { recursive: true });
  await page.evaluate(() => { window.__l3.running = true; });
  await send(page, PROMPT);
  await page.waitForFunction(() => window.__l3.firstAt !== undefined, null, { timeout: 60000 });
  const start = Date.now();
  const times = [];
  for (let i = 0; i < 16; i++) {
    const due = start + i * 1000;
    if (due > Date.now()) await page.waitForTimeout(due - Date.now());
    const state = await page.evaluate(() => ({ arrived: window.__l3.text.length, shown: window.__l3.shown ?? 0, done: window.__l3.finishedAt !== undefined }));
    await page.screenshot({ path: `${OUT}/${TAG}-strip/${String(i).padStart(2, '0')}.png` });
    times.push({ second: i, ...state });
  }
  await writeFile(`${OUT}/${TAG}-strip/frames.json`, JSON.stringify(times, null, 2));
  console.log(times.map((t) => `${t.second}s arrived ${t.arrived} shown ${t.shown}`).join('\n'));
  await browser.close();
}

if (ONLY.has('scroll')) {
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const { browser, page } = await open(type, { dpr: 1 });
    await chat(page, { model: 'l3-100', title: 'L3 scroll', history: ['long prose one', 'long prose two'] });
    const viewport = page.getByTestId('chat-scroll-viewport');
    // Read some way above the bottom, as the owner did, then send.
    await viewport.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 900); });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-scroll-viewport"]');
      const trace = (window.__trace = []);
      const t0 = performance.now();
      const tick = (now) => {
        const bubbles = document.querySelectorAll('[data-testid="user-message-bubble"]');
        const lastBubble = bubbles[bubbles.length - 1];
        trace.push([Math.round(now - t0), Math.round(el.scrollTop * 10) / 10, el.scrollHeight - el.clientHeight, lastBubble ? Math.round(lastBubble.getBoundingClientRect().top - el.getBoundingClientRect().top) : null, bubbles.length]);
        if (now - t0 < 9000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await send(page, 'long prose three');
    await page.waitForTimeout(9300);
    const trace = await page.evaluate(() => window.__trace);
    await page.screenshot({ path: `${OUT}/${TAG}-scroll-send-${name}.png` });
    const sendAt = trace.findIndex((row, i) => i > 0 && row[4] > trace[0][4]);
    const tops = trace.map((row) => row[1]);
    let reversals = 0, direction = 0, travelBack = 0, peak = tops[0];
    for (let i = 1; i < tops.length; i++) {
      const delta = tops[i] - tops[i - 1];
      if (Math.abs(delta) < 0.75) continue;
      const d = Math.sign(delta);
      if (direction && d !== direction) reversals += 1;
      direction = d;
      peak = Math.max(peak, tops[i]);
      if (delta < 0) travelBack += -delta;
    }
    // A landing: the position holds for 200 ms after having moved.
    let landings = 0, still = 0, moving = false;
    for (let i = 1; i < trace.length; i++) {
      if (Math.abs(tops[i] - tops[i - 1]) >= 0.75) { moving = true; still = 0; continue; }
      still += trace[i][0] - trace[i - 1][0];
      if (moving && still >= 200) { landings += 1; moving = false; }
    }
    const summary = { tag: TAG, browser: name, start: tops[0], end: tops.at(-1), peak, reversals, travelBackPx: round(travelBack), landings, monotonic: reversals === 0, sentAtMs: trace[sendAt]?.[0] ?? null, userBubbleTopAtEndPx: trace.at(-1)[3], maxScrollAtEnd: trace.at(-1)[2] };
    await writeFile(`${OUT}/${TAG}-scroll-send-${name}.json`, JSON.stringify({ summary, columns: ['ms', 'scrollTop', 'maxScrollTop', 'userBubbleTop', 'bubbles'], trace }, null, 1));
    // A small chart of scrollTop against time.
    const W = 900, H = 320, pad = 40, tMax = trace.at(-1)[0], yMin = Math.min(...tops), yMax = Math.max(...tops, yMin + 1);
    const x = (t) => pad + (t / tMax) * (W - pad * 2), y = (v) => H - pad - ((v - yMin) / (yMax - yMin)) * (H - pad * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui" font-size="12"><rect width="100%" height="100%" fill="#fff"/><text x="${pad}" y="20">${TAG} · ${name} · scrollTop after send (reversals ${reversals}, landings ${landings}, back-travel ${round(travelBack)} px)</text><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#999"/><text x="${pad}" y="${H - 12}">0 ms</text><text x="${W - pad - 50}" y="${H - 12}">${tMax} ms</text><text x="2" y="${y(yMax) + 4}">${Math.round(yMax)}</text><text x="2" y="${y(yMin) + 4}">${Math.round(yMin)}</text><polyline fill="none" stroke="#d33" stroke-width="2" points="${trace.map((r) => `${x(r[0]).toFixed(1)},${y(r[1]).toFixed(1)}`).join(' ')}"/></svg>`;
    await writeFile(`${OUT}/${TAG}-scroll-send-${name}.svg`, svg);
    console.log(JSON.stringify(summary));
    await browser.close();
  }
}
