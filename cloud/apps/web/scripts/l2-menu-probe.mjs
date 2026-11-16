import { chromium, webkit } from '@playwright/test';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/L/L2/menus`;
const TAG = process.env.TAG ?? 'before';
mkdirSync(OUT, { recursive: true });
const runs = [['chromium', chromium, false], ['webkit', webkit, false], ['safari-sim', webkit, true]];
const report = {};
for (const [name, type, sim] of runs) {
  const browser = await type.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 4, colorScheme: scheme });
    await ctx.addInitScript(({ mode, sim }) => {
      localStorage.setItem('praxis-theme', mode);
      if (!sim) return;
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (a, b) => (String(a).includes('corner-shape') ? false : b === undefined ? supports(a) : supports(a, b));
      document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{corner-shape: round !important}'; document.head.append(s); });
    }, { mode: scheme, sim });
    const page = await ctx.newPage();
    await page.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev', userId: 'l2-menu-probe' } });
    await page.goto(BASE + '/lab/glass?dropdown');
    await page.evaluate((m) => { document.documentElement.dataset.theme = m; }, scheme);
    const trig = page.getByTestId('position-top-start');
    await trig.waitFor();
    await page.waitForTimeout(800);
    const tb = await trig.boundingBox();
    // The closed and the open trigger.
    await page.screenshot({ path: `${OUT}/${TAG}-trigger-closed-${name}-${scheme}.png`, clip: { x: tb.x - 16, y: tb.y - 16, width: tb.width + 32, height: tb.height + 32 } });
    await trig.click();
    const menu = page.locator('.praxis-glass-dropdown-content [data-glass-surface]').first();
    await menu.waitFor();
    await page.waitForTimeout(900);
    await page.mouse.move(1000, 880);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${TAG}-trigger-open-${name}-${scheme}.png`, clip: { x: tb.x - 16, y: tb.y - 16, width: tb.width + 32, height: tb.height + 32 } });
    const surfaces = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="position-top-start"]');
      const out = [];
      for (let n = t; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none' || n.querySelector(':scope > [data-glass-solid], :scope > [data-glass-lens]'))
          out.push({ tag: n.tagName, cls: n.className, bg: s.backgroundColor, h: n.getBoundingClientRect().height, w: n.getBoundingClientRect().width });
        for (const c of n.querySelectorAll(':scope > [data-glass-solid], :scope > [data-glass-lens]')) { const cs = getComputedStyle(c); out.push({ layer: c.dataset.glassSolid !== undefined ? 'solid' : 'lens', bg: cs.backgroundColor, border: cs.border, h: c.getBoundingClientRect().height, w: c.getBoundingClientRect().width }); }
      }
      return out;
    });
    const mb = await menu.boundingBox();
    const geo = await menu.evaluate((el) => {
      const pick = (n) => { const s = getComputedStyle(n); return { r: s.borderRadius, corner: s.getPropertyValue('corner-shape'), clip: s.clipPath, overflow: s.overflow }; };
      const layers = [...el.children].filter((c) => c.tagName === 'SPAN').map((c) => ({ attrs: [...c.attributes].map((a) => a.name).filter((a) => a.startsWith('data')).join(','), ...pick(c) }));
      const anc = []; for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) anc.push({ cls: String(n.className).slice(0, 60), ...pick(n) });
      return { supports: CSS.supports('corner-shape', 'squircle'), root: pick(el), layers, anc };
    });
    report[`${name}-${scheme}`] = { surfaces, geo };
    const S = 56;
    const corners = { tl: [mb.x - 8, mb.y - 8], tr: [mb.x + mb.width - S + 8, mb.y - 8], bl: [mb.x - 8, mb.y + mb.height - S + 8], br: [mb.x + mb.width - S + 8, mb.y + mb.height - S + 8] };
    for (const [k, [x, y]] of Object.entries(corners))
      await page.screenshot({ path: `${OUT}/${TAG}-corner-${k}-${name}-${scheme}.png`, clip: { x, y, width: S, height: S } });
    await ctx.close();
  }
  await browser.close();
}
writeFileSync(`${OUT}/${TAG}-report.json`, JSON.stringify(report, null, 1));
console.log('ok', OUT);
