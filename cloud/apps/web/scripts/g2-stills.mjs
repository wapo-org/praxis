// WP-G2 visual gate: shadows and type, before and after.
import { mkdir } from 'node:fs/promises';
import { engines, openApp, seedChat } from './g1-lib.mjs';
import { homedir } from 'node:os';
const LABEL = process.env.LABEL ?? 'after';
const DIR = `${process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G2`}/stills/${LABEL}`;
await mkdir(DIR, { recursive: true });
const browser = await engines.chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const chat = await seedChat(browser, 3);
for (const theme of ['light', 'dark']) {
  for (const [size, width, height] of [['desktop', 1440, 900], ['mobile', 402, 874]]) {
    const shot = (page, state) => page.screenshot({ path: `${DIR}/${size}-${theme}-${state}.png` });
    const { context, page } = await openApp(browser, { theme, width, height, path: '/' });
    await page.waitForTimeout(900);
    await shot(page, 'empty');
    await page.goto(new URL(chat, page.url()).href);
    await page.getByTestId('assistant-turn').first().waitFor();
    await page.waitForTimeout(1000);
    await shot(page, 'chat');
    if (size === 'mobile') {
      await page.getByTestId('nav-history-button').click();
      await page.getByTestId('app-sidebar').waitFor();
      await page.waitForTimeout(700);
      await shot(page, 'sidebar');
    } else {
      await page.getByTestId('chat-scroll-viewport').evaluate((el) => { el.scrollTop = el.scrollHeight * 0.3; });
      await page.waitForTimeout(400);
      await shot(page, 'sidebar');
    }
    const row = page.locator('[data-sidebar-row]').first();
    await row.hover();
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menu').waitFor();
    await page.waitForTimeout(1000);
    await shot(page, 'menu');
    await context.close();
  }
}
await browser.close();
