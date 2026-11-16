import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233';
const phase = process.env.PHASE ?? 'after';
const dir = `${process.env.HOME}/.praxis-agent-state/cloud/design/H/H1b/${phase}`;
await mkdir(dir, { recursive: true });
const switchToRegister = page => page.getByRole(phase === 'before' ? 'button' : 'link', { name: phase === 'before' ? 'Create an account' : 'Create one', exact: true }).click();
const browser = await chromium.launch();
const report = [];
try {
  for (const [width, height] of [[1440, 900], [402, 874]]) for (const theme of ['light', 'dark']) for (const mode of ['login', 'register']) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.addInitScript(t => { localStorage.setItem('praxis-theme', t); }, theme);
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
    if (mode === 'register') await switchToRegister(page);
    await page.mouse.move(0, 0);
    const name = `${dir}/${mode}-${theme}-${width}`;
    await page.screenshot({ path: `${name}-rest.png` });
    // Phone layout: nothing to scroll at rest.
    const overflow = await page.evaluate(() => { const s = document.querySelector('main'); return s ? s.scrollHeight - s.clientHeight : 0; });
    report.push(`${mode} ${theme} ${width}: overflow ${overflow}px`);
    if (phase === 'before') { await context.close(); continue; }
    const primary = page.getByRole('button', { name: mode === 'login' ? 'Sign in' : 'Create account', exact: true });
    await primary.hover(); await page.screenshot({ path: `${name}-hover.png` });
    const box = await primary.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.screenshot({ path: `${name}-pressed.png` });
    await page.mouse.up(); await page.mouse.move(0, 0);
    await page.getByLabel('Email', { exact: true }).focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await page.screenshot({ path: `${name}-focus.png` });
    await page.getByLabel('Email', { exact: true }).fill('fake@example.test');
    await page.getByLabel('Password', { exact: true }).fill('fake-password-123');
    if (mode === 'register') {
      await primary.click();
      await page.getByLabel('Email code', { exact: true }).waitFor();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${name}-code.png` });
      await page.getByLabel('Email code', { exact: true }).fill('123456');
    }
    let release;
    await page.route('**/v1/auth/dev', async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await page.getByRole('button', { name: mode === 'login' ? 'Sign in' : 'Verify and continue', exact: true }).click();
    await page.locator('button[disabled]').first().waitFor();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${name}-loading.png` });
    release?.();
    await context.close();
  }
} finally { await browser.close(); }
console.log(report.join('\n'));
