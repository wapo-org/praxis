import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5251';
const API = process.env.API ?? 'http://127.0.0.1:8881';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/D3`;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['light', 'dark'])
  for (const [size, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 },
    mobile: { width: 402, height: 874 },
  })) {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const shot = async (name) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${size}-${theme}-${name}.png` });
    };
    await page.goto(BASE);
    await page.getByRole('button', { name: /local dev user/i }).waitFor();
    await shot('sign-in');
    const session = await page.evaluate(async (userId) => {
      const { devAuth } = await import('/src/lib/dev-auth.ts');
      return devAuth(userId);
    }, `d3b-capture-${size}-${theme}`);
    await page.reload();
    await page.getByTestId('chat-top-bar').waitFor();
    for (const script of [
      'tools',
      'approval',
      'nestedApproval',
      'elicitation',
      'cancel',
      'error',
      'markdown',
    ]) {
      const headers = {
        Authorization: `Bearer ${session.bearerToken}`,
        'Content-Type': 'application/json',
      };
      const api = async (path, body) => {
        const response = await fetch(API + path, {
          headers,
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return response.json();
      };
      const chat = await api('/v1/chats', {
        type: 'chat.input',
        title: `D3 ${script}`,
        mode: 'build',
        pinned: script === 'tools',
      });
      await page.goto(`${BASE}/c/${chat.id}`);
      await page.getByTestId('chat-top-bar').waitFor();
      const run = await api('/v1/runs', {
        type: 'run.start',
        chatId: chat.id,
        text:
          script === 'markdown'
            ? '\n\n# Project review\n\n| Approach | Cost |\n| :--- | ---: |\n| Native glass | Low |\n| Masked blur | Medium |\n\n```ts\nconst ready = true;\n```\n\n3. Review `ready`\n4. Open [reference](https://example.com)\n\n- [x] Capture reviewed'
            : `Review ${script}`,
        script: script === 'cancel' ? 'long' : script === 'markdown' ? 'text' : script,
      });
      if (script === 'cancel') {
        await page.getByTestId('composer-stop-button').waitFor();
        await page.screenshot({ path: `${OUT}/${size}-${theme}-running.png` });
        await page.getByTestId('composer-stop-button').click();
      } else if (script === 'approval' || script === 'nestedApproval')
        await page.getByTestId('approval-allow-once').first().waitFor();
      else if (script === 'elicitation') await page.getByTestId('elicitation-submit').waitFor();
      else
        await page.waitForFunction(
          () => !document.querySelector('[data-testid=composer-stop-button]'),
        );
      if (script === 'tools') {
        const fold = page.getByTestId('agent-activity-toggle').last();
        await fold.waitFor();
        await shot('tools-folded');
        if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
      }
      await shot(script);
      if (script === 'tools') {
        await page.locator('[data-testid^=tool-step-header]').first().click();
        await shot('tool-detail');
      }
      await api(`/v1/runs/${run.id}/cancel`, { type: 'run.cancel' }).catch(() => {});
    }
    if (size === 'mobile') await page.getByTestId('nav-history-button').click();
    await shot('history');
    await page.goto(`${BASE}/lab`);
    await page.getByTestId('glass-lab-page').waitFor();
    await shot('lab');
    await context.close();
  }
await browser.close();
