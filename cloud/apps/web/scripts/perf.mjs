// Run with API 8817 + Vite 5191. Captures real local scripted runs; no mocked success paths.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
const out = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/reports/web-fix1`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const measurements = [];
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 402, height: 874 }, colorScheme: theme });
    await context.addInitScript(t => localStorage.setItem('praxis-theme', t), theme);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5191');
    await page.getByRole('button', { name: 'Continue as local dev user' }).click();
    await page.getByTestId('chat-top-bar').waitFor();
    await page.getByTestId('nav-new-chat-button').click();
    await page.getByTestId('starter-chip-0').waitFor();
    const boxes = await page.locator('.chat-header > :not(.chat-header-desktop)').evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return { x: b.x, right: b.right, width: b.width }; }));
    assert(boxes.every(b => b.width > 0 && b.x >= 0 && b.right <= 402));
    assert(boxes[0].right <= boxes[1].x && boxes[1].right <= boxes[2].x);
    await page.screenshot({ path: `${out}/${theme}-top-bar-402.png` });
    await page.getByTestId('starter-chip-1').click();
    await page.getByTestId('assistant-turn').first().waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${out}/${theme}-chat-tools.png` });
    await page.getByTestId('nav-new-chat-button').click();
    await page.getByTestId('starter-chip-2').click();
    const approval = page.getByRole('button', { name: 'Allow Once', exact: true });
    await approval.waitFor({ timeout: 20000 });
    const colors = await approval.evaluate(n => ({ text: getComputedStyle(n).color, background: getComputedStyle(n).backgroundColor }));
    assert.notEqual(colors.text, colors.background);
    await page.screenshot({ path: `${out}/${theme}-approval.png` });
    await approval.click();
    await page.reload();
    await page.getByTestId('chat-top-bar').waitFor();
    const boot = await page.evaluate(() => performance.getEntriesByName('praxis:boot-to-paint').at(-1)?.duration);
    measurements.push({ theme, sessionVerifiedReplicaMountMs: boot, headerBounds: boxes, approvalColors: colors });
    await context.close();
  }
  await writeFile(`${out}/perf.json`, JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify(measurements, null, 2));
} finally { await browser.close(); }
