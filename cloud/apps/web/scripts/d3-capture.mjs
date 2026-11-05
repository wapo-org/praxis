// WP-D3 visual gate. Scripted scenarios: tools, approval, nested approval, elicitation, cancel, error, plus
// markdown, history, sign-in and Lab, at 1440×900 and 402×874, in light and dark, with iOS boards.
// API on 8823, web on 5197. `ONLY=tools,error node apps/web/scripts/d3-capture.mjs` filters states.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE ?? 'http://localhost:5197';
const API = process.env.API ?? 'http://127.0.0.1:8823';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/D3`;
const REF = new URL('../../../docs/web/reference/ios/', import.meta.url).pathname;
const ONLY = process.env.ONLY?.split(',');
const THEMES = process.env.THEMES?.split(',') ?? ['light', 'dark'];
const SIZES = process.env.SIZES?.split(',') ?? ['desktop', 'mobile'];
const want = (name) => !ONLY || ONLY.includes(name);
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.json();
};
await mkdir(OUT, { recursive: true });
await api('/v1/auth/dev', { method: 'POST', body: JSON.stringify({ type: 'auth.dev' }) });
const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 402, height: 874 } };

const newChat = (title) => api('/v1/chats', { method: 'POST', body: JSON.stringify({ type: 'chat.input', title, pinned: false, mode: 'build' }) });
const start = (chatId, text, script) => api('/v1/runs', { method: 'POST', body: JSON.stringify({ type: 'run.start', chatId, text, script }) });
const settled = async (runId) => {
  for (let i = 0; i < 100; i++) {
    const { status } = await api(`/v1/runs/${runId}`);
    if (!['queued', 'running', 'continuing'].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not settle`);
};
async function open(theme, viewport, path = '/') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  await page.evaluate(() => fetch('/v1/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'auth.dev' }) }));
  await page.goto(`${BASE}${path}`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
const settle = (page) => page.waitForTimeout(450);
const MARKDOWN = [
  '## Scrim options, side by side',
  'Here is a **quick** comparison you can adapt, with `inline code`, a [link](https://example.com/guide) and ~~old~~ new text:',
  '| Approach | Cost | Blur |',
  '| :--- | :-: | --: |',
  '| Native `glassEffect` | Low | Adaptive |',
  '| Masked blur bands | Medium | Feathered |',
  '| Flat tint | **None** | ~~Soft~~ none |',
  '',
  '```ts',
  'const scrim = createScrim({ edge: "top", bands: [1, 3, 6, 12] });',
  '```',
  '',
  '1. Measure once',
  '2. Composite on the GPU',
  '',
  '- [x] Tokens only',
  '- [ ] Ship it',
  '',
  '> Glass is for floating chrome only.',
].join('\n');

/** Each scenario opens a chat, gets it to its state, and shoots one or more frames. */
const scenarios = {
  async tools(page, shoot) {
    const chat = await newChat('Make a table of the scrim options');
    await settled((await start(chat.id, 'Make a table of the scrim options', 'tools')).id);
    await page.goto(`${BASE}/c/${chat.id}`);
    const toggle = page.getByTestId('agent-activity-toggle').first();
    await toggle.waitFor();
    await settle(page);
    await shoot('activity-folded');
    await toggle.click();
    await page.getByTestId('agent-activity-steps').waitFor();
    await settle(page);
    await shoot('activity-list');
    await page.locator('[data-testid^="tool-step-header-"]').last().click();
    await settle(page);
    await shoot('activity-detail');
  },
  async approval(page, shoot) {
    const chat = await newChat('Write a file with approval');
    const run = await start(chat.id, 'Write a file with approval', 'approval');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('approval-allow-once').waitFor();
    await settle(page);
    await shoot('approval');
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
  },
  async nested(page, shoot) {
    const chat = await newChat('Run code that writes a file');
    const run = await start(chat.id, 'Run code that writes a file', 'nestedApproval');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('approval-allow-once').waitFor();
    await settle(page);
    await shoot('nested-approval');
    await page.getByTestId('agent-activity-toggle').click();
    await settle(page);
    await shoot('nested-approval-open');
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
  },
  async elicitation(page, shoot) {
    const chat = await newChat('Ask me a clarifying question');
    const run = await start(chat.id, 'Ask me a clarifying question', 'elicitation');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('elicitation-submit').waitFor();
    await settle(page);
    await shoot('elicitation');
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
  },
  async elicitationurl(page, shoot) {
    const chat = await newChat('Sign in to a connector');
    const run = await start(chat.id, 'Sign in to a connector', 'elicitationURL');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('elicitation-submit').waitFor();
    await settle(page);
    await shoot('elicitation-url');
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
  },
  async cancel(page, shoot) {
    const chat = await newChat('Stop this run');
    const run = await start(chat.id, 'Stop this run', 'approval');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('approval-allow-once').waitFor();
    await page.waitForTimeout(1200);
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) });
    await page.getByText(/^Stopped after/).first().waitFor();
    await settle(page);
    await shoot('cancelled');
    await page.reload();
    await page.getByText(/^Stopped after/).first().waitFor();
    await settle(page);
    await shoot('cancelled-reload');
  },
  async error(page, shoot) {
    const chat = await newChat('This run fails');
    await settled((await start(chat.id, 'This run fails', 'error')).id);
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('run-outcome-note').waitFor();
    await settle(page);
    await shoot('error');
  },
  async running(page, shoot) {
    const chat = await newChat('Stream a long answer');
    const run = await start(chat.id, 'Stream a long answer', 'long');
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('agent-activity-toggle').waitFor();
    await shoot('running');
    await fetch(`${API}/v1/runs/${run.id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'run.cancel' }) }).catch(() => {});
  },
  async markdown(page, shoot) {
    const chat = await newChat('Markdown');
    await settled((await start(chat.id, MARKDOWN, 'text')).id);
    await page.goto(`${BASE}/c/${chat.id}`);
    await page.getByTestId('markdown-table-card').waitFor();
    await settle(page);
    await page.getByTestId('markdown-table-card').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.getByTestId('chat-scroll-viewport').evaluate((el) => { el.scrollTop -= 96; });
    await settle(page);
    await shoot('markdown');
  },
  async history(page, shoot, vpName) {
    const pinned = await newChat('Pinned: quarterly plan');
    await api(`/v1/chats/${pinned.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) }).catch(() => {});
    await page.goto(`${BASE}/`);
    await page.getByTestId('chat-top-bar').waitFor();
    await page.goto(`${BASE}/chats`);
    const dialog = page.getByRole('dialog', { name: 'Chats' });
    await dialog.waitFor();
    await settle(page);
    await shoot('history');
    await dialog.getByTestId('history-row').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).waitFor();
    await settle(page);
    await shoot('history-menu');
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await dialog.getByRole('textbox', { name: 'Chat title' }).waitFor();
    await settle(page);
    await shoot('history-rename');
    await page.keyboard.press('Escape');
    if (vpName === 'desktop') {
      await page.goto(`${BASE}/`);
      const row = page.getByTestId('app-sidebar').getByTestId('history-row').nth(1);
      await row.hover();
      await settle(page);
      await shoot('sidebar-hover');
      await row.getByRole('button', { name: /^Actions for/ }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await settle(page);
      await shoot('sidebar-rename');
    }
  },
  async lab(page, shoot) {
    await page.goto(`${BASE}/lab`);
    await page.getByTestId('glass-lab-page').waitFor();
    await settle(page);
    await shoot('lab-top');
    for (const id of ['lab-dropdowns', 'lab-models', 'lab-scrim', 'lab-motion']) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await settle(page);
      await shoot(id);
    }
  },
};

for (const theme of THEMES)
  for (const vpName of SIZES) {
    const viewport = viewports[vpName];
    const tag = `${vpName}-${theme}`;
    if (want('signin')) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
      await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
      const page = await context.newPage();
      await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 401, json: { type: 'error', code: 'unauthorized', message: 'Sign in' } }));
      await page.goto(BASE);
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-signin.png`) });
      await page.getByText('Advanced', { exact: true }).click();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-signin-advanced.png`) });
      await context.close();
    }
    for (const [name, run] of Object.entries(scenarios)) {
      if (!want(name)) continue;
      const { context, page } = await open(theme, viewport);
      const shoot = (state) => page.screenshot({ path: join(OUT, `${tag}-${state}.png`) });
      await run(page, shoot, vpName);
      await context.close();
    }
  }

// Side-by-side boards: web (desktop, narrow) next to the iOS reference. iOS shot activity in light only.
const pairs = {
  'activity-folded': 'light-activity-finished-folded',
  'activity-list': 'light-activity-finished-list',
  'activity-detail': 'light-activity-tool-detail',
  running: 'light-activity-running-stream',
  markdown: 'light-markdown-table',
  history: '%-history-0-top',
};
if (!ONLY || ONLY.includes('boards')) {
  const board = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const dataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  for (const theme of THEMES)
    for (const [state, template] of Object.entries(pairs)) {
      const ref = template.replace('%', theme);
      const paths = [join(OUT, `desktop-${theme}-${state}.png`), join(OUT, `mobile-${theme}-${state}.png`), join(REF, `${ref}.png`)];
      if (!paths.every(existsSync)) continue;
      const imgs = await Promise.all(paths.map(dataUrl));
      await board.setContent(`<body style="margin:0;display:flex;gap:16px;align-items:flex-start;padding:16px;background:#888;font:12px system-ui">
        <figure style="margin:0"><img src="${imgs[0]}" style="height:560px"><figcaption>web 1440</figcaption></figure>
        <figure style="margin:0"><img src="${imgs[1]}" style="height:560px"><figcaption>web 402</figcaption></figure>
        <figure style="margin:0"><img src="${imgs[2]}" style="height:560px"><figcaption>iOS ${ref}</figcaption></figure></body>`);
      await board.screenshot({ path: join(OUT, `compare-${theme}-${state}.png`), fullPage: true });
    }
}
await browser.close();
console.log(JSON.stringify({ out: OUT }));
