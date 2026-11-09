// Per-frame geometry of the + tray (or any morph menu) while it opens: the glass (shell rect), a content row,
// and the morph's progress. Usage: node tray-probe.mjs <chromium|webkit> <out.json> [menu]
import { chromium, webkit } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const [engine = 'chromium', out = '/tmp/i1/tray-probe.json', menu = 'tray'] = process.argv.slice(2);
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233';
const browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'chromium' ? { args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(20000);
await page.goto(BASE);
const dev = page.getByRole('button', { name: 'Continue as local dev user' });
await dev.waitFor({ timeout: 8000 }).then(() => dev.click()).catch(() => {});
await page.getByTestId('chat-top-bar').waitFor();
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
const runs = [];
for (let i = 0; i < 3; i++) {
  await page.evaluate((menu) => {
    const w = window;
    w.__frames = [];
    const sel = menu === 'tray' ? '[data-testid="plus-tray"]' : '.praxis-glass-dropdown-content';
    const loop = (t) => {
      const surface = document.querySelector(sel);
      if (surface) {
        const shell = menu === 'tray' ? surface.parentElement : surface;
        const glass = menu === 'tray' ? surface : surface.querySelector('[data-glass-surface]') ?? surface;
        const row = surface.querySelector('[data-morph-body] [role="radiogroup"], [data-morph-body] button, [data-morph-body] [role="menuitem"]');
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => +v.toFixed(2)); };
        w.__frames.push({ t: +t.toFixed(2), shell: r(shell), glass: r(glass), row: r(row), transform: shell.style.transform, morphing: glass.dataset?.morphing ?? surface.dataset.morphing ?? null });
      }
      if (w.__frames.length < 400) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, menu);
  if (menu === 'tray') await page.getByTestId('composer-plus-button').click();
  else await page.getByTestId(menu).click();
  await page.waitForTimeout(1600);
  runs.push(await page.evaluate(() => window.__frames));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}
writeFileSync(out, JSON.stringify(runs));
// Summary: the content row's movement once the glass has reached 95 % of its rest width, and the last 10 frames.
for (const [k, frames] of runs.entries()) {
  const rest = frames.at(-1);
  const fast = frames.findIndex((f) => f.glass && Math.abs(f.glass[2] - rest.glass[2]) / rest.glass[2] < 0.05 && Math.abs(f.glass[3] - rest.glass[3]) / rest.glass[3] < 0.05);
  const after = frames.slice(fast);
  const span = (key, idx) => { const v = after.map((f) => f[key]?.[idx]).filter((x) => x != null); return +(Math.max(...v) - Math.min(...v)).toFixed(2); };
  console.log(`${engine} run ${k}: frames ${frames.length}, fast phase ends at frame ${fast} (${(frames[fast]?.t - frames[0].t).toFixed(0)} ms)`);
  console.log(`  after: glass x ${span('glass', 0)} y ${span('glass', 1)} w ${span('glass', 2)} h ${span('glass', 3)} | row x ${span('row', 0)} y ${span('row', 1)}`);
  let last = null;
  for (const f of frames) {
    const key = JSON.stringify([f.glass, f.row]);
    if (key !== last) { last = key; }
  }
  const changes = frames.filter((f, i) => i && JSON.stringify([f.glass, f.row]) !== JSON.stringify([frames[i - 1].glass, frames[i - 1].row]));
  for (const f of changes.slice(-8)) console.log(`   t=${(f.t - frames[0].t).toFixed(0)} glass=${f.glass} row=${f.row} morphing=${f.morphing}`);
}
await browser.close();
