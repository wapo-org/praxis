import { chromium, webkit } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5261';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G5/raw`;
const TAG = process.env.TAG ?? 'after';
const engine = process.env.ENGINE === 'webkit' ? webkit : chromium;
await mkdir(OUT, { recursive: true });
const browser = await engine.launch();
const prefix = `${OUT}/${process.env.ENGINE ?? 'chromium'}-${TAG}`;
for (const theme of ['light', 'dark'])
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, colorScheme: theme });
    await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
    await context.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev', userId: `g5-composer-${theme}-${dpr}` } });
    const page = await context.newPage();
    await page.goto(BASE + '/');
    const surface = page.getByTestId('composer-surface');
    await surface.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(700, 300);
    await page.waitForTimeout(1200);
    const shoot = async (name) => {
      const b = (await surface.boundingBox());
      await page.screenshot({ path: `${prefix}-${theme}-dpr${dpr}-${name}-left.png`, clip: { x: b.x - 16, y: b.y - 16, width: 120, height: b.height + 32 } });
      await page.screenshot({ path: `${prefix}-${theme}-dpr${dpr}-${name}-right.png`, clip: { x: b.x + b.width - 104, y: b.y - 16, width: 120, height: b.height + 32 } });
    };
    await shoot('idle');
    if (dpr === 2) {
      await page.screenshot({ path: `${prefix}-${theme}-dpr2-top.png`, clip: { x: 0, y: 0, width: 1440, height: 110 } });
      // A menu (glass thick, card corner) from the composer's plus.
      await page.getByTestId('composer-plus-button').click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${prefix}-${theme}-dpr2-tray.png` });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    // Text scrolled behind the composer: a long reply under it.
    const chat = await (await context.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title: 'Behind the composer' } })).json();
    const text = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`).join('\n\n');
    await page.goto(BASE + '/c/' + chat.id);
    await surface.waitFor();
    await context.request.post(BASE + '/v1/runs', { data: { type: 'run.start', chatId: chat.id, text, script: 'text' } });
    await page.getByText('Line 40:').waitFor({ timeout: 20000 }).catch(() => {});
    await page.mouse.move(700, 300);
    await page.mouse.wheel(0, -260);
    await page.waitForTimeout(1200);
    await shoot('text');
    await page.screenshot({ path: `${prefix}-${theme}-dpr${dpr}-text-full.png` });
    await context.close();
  }
await browser.close();
console.log('ok', prefix);
