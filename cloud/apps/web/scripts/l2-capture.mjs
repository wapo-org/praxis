// WP-L2 visual gate: the tray rows (§1), the consent sheet (§3), the button and input audit (§4) and
// Settings → Secrets & variables (§5), light and dark.
//   BASE=http://127.0.0.1:5232 TAG=before|after [ONLY=tray,consent,audit,secrets] [ENGINES=chromium,webkit] node apps/web/scripts/l2-capture.mjs
import { chromium, webkit } from '@playwright/test';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/L/L2`;
const TAG = process.env.TAG ?? 'after';
const ONLY = (process.env.ONLY ?? 'tray,consent,audit,secrets').split(',');
const ENGINES = (process.env.ENGINES ?? 'chromium,webkit').split(',');
mkdirSync(OUT, { recursive: true });
const user = `l2-capture-${Date.now()}`;
const auth = { Authorization: 'Bearer dev-local', 'content-type': 'application/json' };

async function open(browser, scheme, path = '/', viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.addInitScript((mode) => localStorage.setItem('praxis-theme', mode), scheme);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev', userId: user } });
  await page.goto(BASE + path);
  await page.evaluate((m) => { document.documentElement.dataset.theme = m; }, scheme);
  await page.waitForTimeout(600);
  await page.evaluate((m) => { document.documentElement.dataset.theme = m; }, scheme);
  return { ctx, page };
}

for (const engineName of ENGINES) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${TAG}-${name}-${engineName}.png`, ...opts });
  for (const scheme of ['light', 'dark']) {
    if (ONLY.includes('tray')) {
      const { ctx, page } = await open(browser, scheme);
      await page.getByTestId('composer-plus-button').click();
      const tray = page.getByTestId('plus-tray');
      await tray.waitFor();
      await page.waitForTimeout(900);
      const b = await tray.boundingBox();
      await shot(page, `tray-${scheme}`, { clip: { x: b.x - 16, y: b.y - 16, width: b.width + 32, height: b.height + 32 } });
      // Hover the middle row: the highlight must stay inside the group's shape.
      const row = tray.getByRole('button', { name: /Connectors/ });
      await row.hover();
      await page.waitForTimeout(250);
      await shot(page, `tray-hover-${scheme}`, { clip: { x: b.x - 16, y: b.y - 16, width: b.width + 32, height: b.height + 32 } });
      await ctx.close();
    }
    if (ONLY.includes('consent')) {
      for (const [label, viewport] of [['tall', { width: 1280, height: 980 }], ['short', { width: 1280, height: 640 }], ['tiny', { width: 1280, height: 470 }]]) {
        const { ctx, page } = await open(browser, scheme, '/lab/glass', viewport);
        await page.getByTestId('glass-lab-consent-demo').click();
        const pop = page.getByTestId('consent-popover');
        await pop.waitFor();
        await page.waitForTimeout(700);
        const b = await pop.boundingBox();
        await shot(page, `consent-${label}-${scheme}`, { clip: { x: b.x - 24, y: Math.max(0, b.y - 24), width: b.width + 48, height: b.height + 48 } });
        await ctx.close();
      }
    }
    if (ONLY.includes('audit')) {
      const pages = [
        ['provider-editor', '/settings/providers/new'],
        ['connector-add', '/settings/connectors/add'],
        ['account', '/settings/account'],
        ['saved-values-form', '/settings/saved-values'],
      ];
      for (const [name, path] of pages) {
        const { ctx, page } = await open(browser, scheme, path);
        await page.getByTestId('settings-page').waitFor().catch(() => {});
        await page.waitForTimeout(500);
        await shot(page, `audit-${name}-${scheme}`);
        await ctx.close();
      }
      const { ctx, page } = await open(browser, scheme);
      await page.getByTestId('composer-input').fill('Start an elicitation');
      await page.getByTestId('composer-send-button').click();
      const card = page.getByTestId('elicitation-form-surface');
      await card.waitFor();
      await page.waitForTimeout(500);
      const b = await card.boundingBox();
      await shot(page, `audit-question-${scheme}`, { clip: { x: b.x - 24, y: b.y - 60, width: b.width + 48, height: b.height + 84 } });
      await ctx.close();
    }
    if (ONLY.includes('secrets')) {
      const { ctx, page } = await open(browser, scheme, '/settings/saved-values');
      const existing = (await (await page.request.get(BASE + '/v1/saved-values?limit=1')).json()).items ?? [];
      if (!existing.length) {
        const kinds = ['variable', 'secret'];
        for (let i = 0; i < 36; i++) {
          const kind = kinds[i % 3 === 0 ? 1 : 0];
          await page.request.post(BASE + '/v1/saved-values', { data: { name: `${kind === 'secret' ? 'token' : 'var'}_${String(i).padStart(2, '0')}`, kind, value: kind === 'secret' ? 'SYNTH-' + i : `value-${i}-${'x'.repeat(i % 7 * 6)}` } });
        }
      }
      await page.reload();
      await page.evaluate((m) => { document.documentElement.dataset.theme = m; }, scheme);
      await page.waitForTimeout(900);
      await shot(page, `secrets-list-${scheme}`);
      const add = page.getByRole('button', { name: 'Add new', exact: true });
      if (await add.count()) {
        await add.click(); await page.waitForTimeout(500);
        await shot(page, `secrets-add-${scheme}`);
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        await page.getByRole('button', { name: /^Edit / }).first().click(); await page.waitForTimeout(500);
        await shot(page, `secrets-edit-${scheme}`);
      }
      await ctx.close();
    }
  }
  await browser.close();
}
console.log('ok', OUT);
