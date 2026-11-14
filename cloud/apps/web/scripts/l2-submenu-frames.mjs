// WP-L2 §2 (L-ref/13): the in-place submenu resize ("Recent chats" in the lab's Actions menu). Logs the glass's
// painted height every frame (read after paint: rAF, then a posted task) in Chromium and WebKit, and in Chromium
// saves a CDP screencast strip with the height measured from the pixels.
//   BASE=http://127.0.0.1:5232 TAG=before|after node apps/web/scripts/l2-submenu-frames.mjs
import { chromium, webkit } from '@playwright/test';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/L/L2/submenu`;
const TAG = process.env.TAG ?? 'before';
const RUNS = Number(process.env.RUNS ?? 3);
mkdirSync(OUT, { recursive: true });
const summary = {};
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev', userId: 'l2-frames' } });
  await page.goto(BASE + '/lab/glass');
  await page.getByTestId('motion-preview-trigger').waitFor();
  await page.waitForTimeout(800);
  const results = [];
  for (let run = 0; run < RUNS; run++) {
    for (const dir of ['in', 'out']) {
      if (dir === 'in') {
        await page.getByTestId('motion-preview-trigger').click();
        await page.waitForTimeout(900);
      }
      await page.evaluate(() => {
        const log = (window.__frames = []);
        const surface = () => document.querySelector('.praxis-glass-dropdown-content [data-glass-surface]');
        const ch = new MessageChannel();
        let stop = false;
        ch.port1.onmessage = () => {
          const s = surface();
          if (s) { const r = s.getBoundingClientRect(); log.push({ t: performance.now(), h: +r.height.toFixed(2), w: +r.width.toFixed(2), panels: document.querySelectorAll('[data-dropdown-panel]').length }); }
        };
        const loop = () => { if (stop) return; ch.port2.postMessage(0); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        window.__stopFrames = () => { stop = true; };
      });
      let cdp = null; const shots = [];
      if (name === 'chromium' && run === 0) {
        cdp = await ctx.newCDPSession(page);
        cdp.on('Page.screencastFrame', async (f) => { shots.push({ t: f.metadata.timestamp, data: f.data }); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
        await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
        await page.waitForTimeout(150);
      }
      if (dir === 'in') await page.getByTestId('recent-chats-subtrigger').click();
      else await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(800);
      if (cdp) { await cdp.send('Page.stopScreencast'); await cdp.detach(); }
      const frames = await page.evaluate(() => { window.__stopFrames(); return window.__frames; });
      // Monotonic: once the height starts moving toward the target, it never steps back toward where it came from.
      const hs = frames.map((f) => f.h);
      const from = hs[0], to = hs.at(-1), sign = Math.sign(to - from);
      let reversals = 0, worst = 0, peak = from;
      for (const h of hs) {
        if (sign > 0) { if (h < peak - 0.5) { reversals++; worst = Math.max(worst, peak - h); } peak = Math.max(peak, h); }
        else if (sign < 0) { if (h > peak + 0.5) { reversals++; worst = Math.max(worst, h - peak); } peak = Math.min(peak, h); }
      }
      // An overshoot past the target is allowed by the spring; a return to the start is not.
      results.push({ run, dir, from, to, frames: hs.length, reversals, worstBackstep: +worst.toFixed(1), heights: hs });
      if (shots.length) {
        const dirOut = `${OUT}/${TAG}-${dir}-frames`;
        mkdirSync(dirOut, { recursive: true });
        shots.forEach((s, i) => writeFileSync(`${dirOut}/${String(i).padStart(3, '0')}.png`, Buffer.from(s.data, 'base64')));
      }
      if (dir === 'out') { await page.keyboard.press('Escape'); await page.waitForTimeout(600); }
    }
  }
  summary[name] = results;
  await browser.close();
}
writeFileSync(`${OUT}/${TAG}-frames.json`, JSON.stringify(summary, null, 1));
for (const [k, v] of Object.entries(summary)) for (const r of v) console.log(k, r.run, r.dir, `${r.from}->${r.to}`, 'frames', r.frames, 'reversals', r.reversals, 'worst', r.worstBackstep, r.heights.slice(0, 28).join(' '));
