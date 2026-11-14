import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5241',
  OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G4/B`;
await mkdir(OUT, { recursive: true });
const b = await chromium.launch();
const metrics = [];
for (const theme of ['light', 'dark'])
  for (const [size, viewport] of Object.entries({
    desk: { width: 1440, height: 900 },
    phone: { width: 402, height: 874 },
  })) {
    const c = await b.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
    await c.addInitScript((t) => {
      localStorage.setItem('praxis-theme', t);
      if (!localStorage.getItem('praxis-accent')) localStorage.setItem('praxis-accent', 'neutral');
    }, theme);
    await c.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev' } });
    const chats = await (await c.request.get(BASE + '/v1/chats?limit=100')).json();
    for (const chat of chats.items) await c.request.delete(BASE + '/v1/chats/' + chat.id);
    let selected;
    for (const title of ['Regex help', 'Trip packing list', 'New chat4et'])
      selected = await (
        await c.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title } })
      ).json();
    const p = await c.newPage();
    await p.goto(BASE + '/c/' + selected.id);
    await p.getByTestId('chat-top-bar').waitFor();
    if (size === 'phone') await p.getByTestId('nav-history-button').click();
    await p.getByTestId('app-sidebar').waitFor();
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(700);
    const shot = async (name) => {
      await p.waitForTimeout(350);
      await p.screenshot({ path: `${OUT}/${size}-${theme}-${name}.png` });
    };
    await shot('sidebar');
    await p
      .getByTestId('app-sidebar')
      .screenshot({ path: `${OUT}/${size}-${theme}-sidebar-crop.png` });
    metrics.push(
      await p.getByTestId('app-sidebar').evaluate((el) => {
        const s = getComputedStyle(el.querySelector('[data-glass-surface]'));
        return {
          theme: document.documentElement.dataset.theme,
          box: el.getBoundingClientRect().toJSON(),
          tint: s.getPropertyValue('--glass-thick-tint'),
          pill: el.querySelector('[data-testid=sidebar-new-chat]').getBoundingClientRect().toJSON(),
          row: el.querySelector('[data-sidebar-row]').getBoundingClientRect().toJSON(),
        };
      }),
    );
    const ref = await c.newPage();
    await ref.goto(
      `file://${homedir()}/.praxis-agent-state/cloud/design/G4-ref/sidebar-design.html`,
    );
    await ref.locator('aside').waitFor();
    await ref.evaluate(() => document.fonts.ready);
    await ref.screenshot({ path: `${OUT}/${size}-${theme}-reference.png` });
    await ref.locator('aside').screenshot({ path: `${OUT}/${size}-${theme}-reference-crop.png` });
    await ref.close();
    await p.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'glass-backdrop-proof';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'position:fixed;inset:0 auto 0 0;width:250px;z-index:39;pointer-events:none;background:repeating-linear-gradient(35deg,#fff 0 12px,#197bd3 12px 24px,#a95b38 24px 36px)';
      document.body.append(el);
    });
    await shot('glass-backdrop');
    await p.evaluate(() => document.getElementById('glass-backdrop-proof')?.remove());
    const row = p.locator('[data-sidebar-row]').first();
    await row.hover();
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await p.getByTestId('composer-input').focus();
    await p.mouse.move(390, 800);
    await shot('pinned');
    await row.hover();
    await shot('pinned-hover');
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menu').waitFor();
    await shot('pinned-menu');
    await p.keyboard.press('Escape');
    await p.goto(BASE + '/settings/general');
    await p.getByTestId('settings-page').waitFor();
    if (size === 'phone') await p.getByTestId('nav-sidebar-button').click();
    await p.getByTestId('settings-back').waitFor();
    await shot('back');
    if (size === 'phone') await p.getByTestId('sidebar-toggle').click();
    for (const accent of ['Neutral', 'Blue', 'Violet', 'Rose', 'Amber', 'Green']) {
      await p.getByRole('radio', { name: accent, exact: true }).click();
      await shot('accent-' + accent.toLowerCase());
    }
    await p.getByRole('radio', { name: 'Blue', exact: true }).click();
    await p.goto(BASE + '/c/' + selected.id);
    await p.getByTestId('composer-input').fill('Accent preview');
    await shot('accent-send');
    await c.request.post(BASE + '/v1/runs', {
      data: {
        type: 'run.start',
        chatId: selected.id,
        text: 'Approve the project update',
        script: 'approval',
      },
    });
    await p.getByTestId('approval-allow-once').waitFor();
    await shot('accent-approval');
    await c.close();
  }
await writeFile(OUT + '/implementation-dom.json', JSON.stringify(metrics, null, 2));
await b.close();
