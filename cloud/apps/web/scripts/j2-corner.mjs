import { chromium, webkit } from '@playwright/test';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/J/J2`;
const TAG = process.env.TAG ?? 'before';
const runs = [['chromium', chromium, false], ['webkit', webkit, false], ['safari-sim', webkit, true]];
for (const [name, type, sim] of runs) {
  const browser = await type.launch();
  for (const scheme of ['dark', 'light']) for (const dpr of [1, 2]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr, colorScheme: scheme });
    await ctx.addInitScript(({ mode, sim }) => {
      localStorage.setItem('praxis-theme', mode);
      if (!sim) return;
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (a, b) => (String(a).includes('corner-shape') ? false : b === undefined ? supports(a) : supports(a, b));
      document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{corner-shape: round !important}'; document.head.append(s); });
    }, { mode: scheme, sim });
    const page = await ctx.newPage();
    await page.goto(BASE);
    const dev = page.getByRole('button', { name: 'Continue as local dev user' });
    await dev.waitFor(); await dev.click();
    await page.getByTestId('composer-surface').waitFor();
    await page.evaluate(async (mode) => { const { apiClient } = await import('/src/lib/api.ts'); await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field: 'theme', value: mode }) }).catch(() => {}); }, scheme);
    await page.reload(); await page.getByTestId('composer-surface').waitFor();
    await page.waitForTimeout(1500);
    const box = await page.getByTestId('composer-surface').boundingBox();
    await page.screenshot({ path: `${OUT}/${TAG}-4-corner-${name}-${scheme}-dpr${dpr}.png`, clip: { x: box.x - 12, y: box.y - 12, width: 120, height: box.height + 24 } });
    await ctx.close();
  }
  await browser.close();
}
