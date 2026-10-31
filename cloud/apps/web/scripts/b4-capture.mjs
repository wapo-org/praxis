import { BASE, API } from './check-env.mjs';
import { chromium, webkit } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const out = process.env.B4_OUT ?? `${homedir()}/.praxis-agent-state/cloud/reports/web-b4`;
await mkdir(out, { recursive: true });
const metadata = [];
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  try {
    for (const width of [402, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 874 } }); page.setDefaultTimeout(15000);
      await page.request.post(`${BASE}/v1/auth/dev`, { data: { type: 'auth.dev', userId: 'b4-captures' } });
      await page.goto(`${BASE}/lab/glass`);
      const trigger = page.getByTestId('apple-notes-menu-trigger'); await trigger.scrollIntoViewIfNeeded();
      await trigger.evaluate(el => { const lab = el.closest('[data-testid="glass-lab-page"]'); lab.scrollTop += el.getBoundingClientRect().top - 130; });
      await trigger.click(); const menu = page.getByRole('menu');
      await page.waitForFunction(() => Math.abs(document.querySelector('[role="menu"]').getBoundingClientRect().width - 240) < .1);
      const capture = async (state, frame, midway = false) => {
        const prefix = `${engine}-${width}-${state}`;
        await page.screenshot({ path: `${out}/${prefix}.png`, animations: 'allow' });
        const box = await menu.boundingBox();
        const clip = { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: Math.min(width - Math.max(0, box.x - 12), box.width + 24), height: Math.min(874 - Math.max(0, box.y - 12), box.height + 24) };
        const web = await page.screenshot({ clip, animations: 'allow' });
        await writeFile(`${out}/${prefix}-menu.png`, web);
        const reference = await readFile(`${homedir()}/Downloads/dwfef/${frame}.PNG`);
        const proof = await browser.newPage({ viewport: { width: 620, height: 650 } });
        const refHeight = frame === 'IMG_7752' ? 960 : 1160;
        // CSS crop only: preserve original frame pixels and put both menu crops at the same display width.
        await proof.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;padding:16px;font:14px system-ui;background:#f2f2ef}h1{font-size:16px}.cols{display:flex;gap:20px}.col{width:280px}.crop{position:relative;width:264px;height:${refHeight * 264 / 550}px;overflow:hidden;background:white}.crop img{position:absolute;width:${1290 * 264 / 550}px;max-width:none;left:${-515 * 264 / 550}px;top:${-480 * 264 / 550}px}img.web{width:264px;height:auto}</style><h1>${engine} · ${width}px · ${state}${midway ? ' (mid-animation)' : ''}</h1><div class="cols"><div class="col"><p>Reference ${frame}</p><div class="crop"><img src="data:image/png;base64,${reference.toString('base64')}"></div></div><div class="col"><p>Web · matching 240px card</p><img class="web" src="data:image/png;base64,${web.toString('base64')}"></div></div></html>`);
        await proof.screenshot({ path: `${out}/${prefix}-comparison.png` }); await proof.close();
        metadata.push({ engine, width, state, frame, menu: box, clip });
      };
      await capture('open', 'IMG_7752');
      const recent = page.getByTestId('recent-notes-subtrigger');
      await recent.click();
      await page.waitForTimeout(90); // Deliberately sample the morph, not a settled screenshot.
      await capture('morph-midway', 'IMG_7771', true);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-dropdown-panel="recent-notes"] [data-dropdown-child]')].every(el => getComputedStyle(el).opacity === '1'));
      await capture('submenu', 'IMG_7774');
      await page.setViewportSize({ width, height: 600 });
      await page.waitForFunction(() => {
        const el = document.querySelector('[role="menu"]');
        return el && [el, ...el.querySelectorAll('[data-slot="scroll-blur-viewport"]')].some(n => n.scrollHeight > n.clientHeight + 1);
      });
      await menu.evaluate(el => {
        const scroll = [el, ...el.querySelectorAll('[data-slot="scroll-blur-viewport"]')].find(n => n.scrollHeight > n.clientHeight + 1);
        if (!scroll) throw Error('Expected scrollable Recent Notes list'); scroll.scrollTop = scroll.scrollHeight;
      });
      await capture('scrolled-list', 'IMG_7774');
      await page.close();
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/captures.json`, JSON.stringify(metadata, null, 2));
console.log(`PASS: ${metadata.length} states and side-by-sides in ${out}`);
