import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../../../docs/web/reference/web/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const base = BASE;
try {
  for (const [variant, theme, width, height] of [['mobile-light', 'light', 402, 874], ['mobile-dark', 'dark', 402, 874], ['desktop-light', 'light', 1440, 900]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, isMobile: width === 402, hasTouch: width === 402 });
    await context.addInitScript(theme => localStorage.setItem('praxis-theme', theme), theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => { throw error; });
    await page.goto(base); await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
    await page.evaluate(async user => { const { apiClient } = await import('/src/lib/api.ts'); await (await import('/src/lib/dev-auth.ts')).devAuth(user); }, `wp-b3-parity-${variant}-${Date.now()}`);
    await page.reload(); await page.getByTestId('nav-chat-title-pill').getByText('Praxis Scripted', { exact: true }).waitFor();
    const capture = async name => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${out}/b3-${variant}-${name}.png`, animations: 'disabled' });
    };
    await capture('chat-empty');
    await page.getByTestId('composer-plus-button').click(); await page.getByTestId('plus-tray').waitFor(); await capture('plus-tray');
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('starter-chip-1').click(); await page.getByTestId('assistant-turn').first().waitFor();
    await page.getByText(/^Worked for \d+s$/).waitFor(); await capture('chat-tools');
    await page.getByText(/^Worked for \d+s$/).click(); await capture('activity-expanded');
    await page.getByTestId('nav-new-chat-button').click(); await page.getByTestId('starter-chip-2').click();
    const approval = page.getByRole('button', { name: 'Allow Once', exact: true }); await approval.waitFor(); await capture('approval'); await approval.click();
    for (const [name, path, label] of [
      ['history', '/chats', 'Chats'], ['settings', '/settings', 'Settings'], ['provider', '/settings/providers/new', 'Provider'],
      ['connectors', '/settings/connectors', 'Connectors'], ['connector-add', '/settings/connectors/add', 'Add by URL'],
      ['skills', '/settings/skills', 'Skills'], ['image-reader', '/settings/images', 'Image reading model'],
      ['voice', '/settings/voice', 'Voice input'], ['sharing', '/settings/sharing', 'Data consents'],
    ]) {
      await page.goto(base + path); await page.getByRole('dialog', { name: label, exact: true }).waitFor();
      await capture(name);
      if (name === 'provider') {
        await page.getByText('Hosted web search', { exact: true }).scrollIntoViewIfNeeded(); await capture('provider-capabilities');
      }
    }
    await context.close();
  }
  console.log('PASS: 45 screenshots, 402×874 light/dark and 1440×900 light, real local API data');
} finally { await browser.close(); }
