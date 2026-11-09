// WP-I1 captures, run against any build of the app (before: 2f19672 / 666b524; after: redesign/liquid-i1).
//   BASE=http://127.0.0.1:5233 API=http://127.0.0.1:8863 OUT=/tmp/i1/after node apps/web/scripts/i1-capture.mjs main cards search tray
// main:   the same seeded chat, light and dark, 1440 and 402, full page (compare with i1-compare.py).
// cards:  the elicitation card in every state (mounted from the module the server is serving), light and dark.
// search: the search panel empty, with results and with no results, light and dark.
// tray:   the + tray at rest, light and dark.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233';
const API = process.env.API ?? BASE;
const OUT = process.env.OUT ?? '/tmp/i1/raw';
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['main', 'cards', 'search', 'tray'];
await mkdir(OUT, { recursive: true });
const auth = { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.json();
};
const browser = await chromium.launch();

async function open(theme, viewport, path = '/') {
  // The dev account's synced theme and palette win over local storage: set them on the account.
  for (const [field, value] of [['theme', theme], ['palette', 'graphite']])
    await api('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field, value }) }).catch(() => {});
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${BASE}${path}`);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  if (await dev.waitFor({ timeout: 6000 }).then(() => true, () => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
  await page.waitForTimeout(300);
  await page.mouse.move(viewport.width - 2, viewport.height / 2);
  return { context, page };
}

async function seedChat() {
  const title = 'Revert check';
  const existing = (await api('/v1/chats')).items?.find((c) => c.title === title);
  if (existing) return existing.id;
  const chat = await api('/v1/chats', { method: 'POST', body: JSON.stringify({ type: 'chat.input', title, pinned: false, mode: 'build' }) });
  for (const text of ['Packing list for a weekend in Lisbon', 'And a short note for the neighbours', 'Thanks']) {
    const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ type: 'run.start', chatId: chat.id, text, script: 'text' }) });
    for (let i = 0; i < 100; i++) {
      const s = await api(`/v1/runs/${run.id}`);
      if (['completed', 'failed', 'cancelled'].includes((s.run ?? s).status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return chat.id;
}

if (parts.includes('main')) {
  const id = await seedChat();
  const meta = {};
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 402]) {
      const viewport = { width, height: width > 500 ? 900 : 874 };
      const { context, page } = await open(theme, viewport, `/c/${encodeURIComponent(id)}`);
      await page.getByTestId('assistant-turn').last().waitFor();
      await page.waitForTimeout(600);
      const sidebar = await page.getByTestId('app-sidebar').first().boundingBox().catch(() => null);
      meta[`${width}-${theme}`] = { sidebar };
      await page.screenshot({ path: `${OUT}/main-${width}-${theme}.png` });
      await context.close();
    }
  await writeFile(`${OUT}/main-meta.json`, JSON.stringify(meta, null, 2));
}

// Every elicitation state, rendered by the module the dev server serves (the real component and its CSS).
const STATES = [
  ['form-one', { id: 'e1', message: 'Provide a name', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }],
  ['form-many', {
    id: 'e2', message: 'A few details before deploying', connectorName: 'Deploy Bot',
    schema: { type: 'object', required: ['service', 'replicas'], properties: {
      service: { type: 'string', title: 'Service name', description: 'As it appears in the dashboard' },
      replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 10 },
      region: { type: 'string', title: 'Region', enum: ['eu-west', 'us-east', 'ap-south'] },
      canary: { type: 'boolean', title: 'Canary first', description: 'Roll out to 5 % before everyone' },
    } },
  }],
  ['url', { id: 'e3', message: 'Sign in to GitHub to continue', mode: 'url', url: 'https://github.com/login/oauth/authorize?client_id=x', connectorName: 'GitHub' }],
  ['free', { id: 'e4', message: 'Anything else I should know?', schema: {} }],
];
if (parts.includes('cards')) {
  for (const theme of ['light', 'dark']) {
    const { context, page } = await open(theme, { width: 900, height: 700 });
    for (const [name, elicitation] of STATES) {
      for (const step of ['open', 'error', 'filled', 'submitted', 'declined', 'cancelled']) {
        if (name !== 'form-many' && ['error', 'filled'].includes(step)) continue;
        if (name !== 'form-many' && name !== 'form-one' && step !== 'open') continue;
        const ok = await page.evaluate(async ({ elicitation, step }) => {
          // The exact dep URLs the app uses (with Vite's ?v= hash), so the harness shares the app's React.
          const dep = async (from, name) => (await (await fetch(from)).text()).match(new RegExp(`"(/node_modules/\\.vite/deps/${name}\\.js[^"]*)"`))[1];
          const React = (await import(await dep('/src/main.tsx', 'react'))).default;
          const client = await import(await dep('/src/main.tsx', 'react-dom_client'));
          const createRoot = client.createRoot ?? client.default.createRoot;
          const { ElicitationCards } = await import('/src/components/chat/ElicitationCards.tsx');
          document.getElementById('i1-stage')?.remove();
          const stage = document.createElement('div');
          stage.id = 'i1-stage';
          stage.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--paper-gradient, var(--color-paper));padding:40px 60px;overflow:auto';
          const column = document.createElement('div');
          column.style.cssText = 'max-width:640px;display:flex;flex-direction:column;align-items:flex-start';
          stage.appendChild(column);
          document.body.appendChild(stage);
          window.__i1Root?.unmount();
          const root = createRoot(column);
          window.__i1Root = root;
          function Harness() {
            const [values, setValues] = React.useState({});
            const [pending, setPending] = React.useState([elicitation]);
            window.__i1Resolve = () => setPending([]);
            return React.createElement(ElicitationCards, {
              pendingElicitations: pending, runId: 'r', elicitationValues: values, setElicitationValues: setValues,
              onResolveElicitation: async () => { await new Promise((r) => setTimeout(r, 30)); setPending([]); },
            });
          }
          root.render(React.createElement(Harness));
          await new Promise((r) => setTimeout(r, 120));
          return true;
        }, { elicitation, step });
        if (!ok) continue;
        const stage = page.locator('#i1-stage');
        const fill = async () => {
          const card = stage.locator('[data-testid^="elicitation-card-"]');
          for (const [key, value] of [['service', 'checkout-api'], ['replicas', '3'], ['name', 'Ada Lovelace']]) {
            const input = card.getByTestId(`elicitation-input-${key}`);
            if (await input.count()) await input.fill(value);
          }
          const region = card.getByRole('radio', { name: 'eu-west' });
          if (await region.count()) await region.click();
          const canary = card.getByRole('switch');
          if (await canary.count()) await canary.check();
        };
        if (step === 'error') {
          await stage.getByTestId('elicitation-submit').click();
          await stage.getByTestId('elicitation-input-replicas').fill('0').catch(() => {});
        }
        if (step === 'filled') {
          await fill();
          await stage.getByTestId(`elicitation-input-service`).focus().catch(() => {});
        }
        if (step === 'submitted') { await fill(); await stage.getByTestId('elicitation-submit').click(); }
        if (step === 'declined') await stage.getByTestId('elicitation-decline').click();
        if (step === 'cancelled') await stage.getByTestId('elicitation-cancel').click();
        await page.waitForTimeout(250);
        const box = await stage.locator('div').first().boundingBox();
        await page.screenshot({ path: `${OUT}/card-${name}-${step}-${theme}.png`, clip: { x: 0, y: 0, width: 900, height: Math.min(700, Math.max(160, box.y + box.height + 40)) } });
      }
    }
    await context.close();
  }
}

if (parts.includes('search')) {
  for (const theme of ['light', 'dark']) {
    const { context, page } = await open(theme, { width: 1440, height: 900 });
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('search-palette');
    await palette.waitFor();
    await page.waitForTimeout(500);
    const shot = async (tag) => {
      const b = await palette.boundingBox();
      await page.screenshot({ path: `${OUT}/search-${tag}-${theme}.png`, clip: { x: b.x - 24, y: b.y - 24, width: b.width + 48, height: b.height + 48 } });
    };
    await shot('empty');
    await palette.getByRole('combobox').fill('Lisbon');
    await page.waitForTimeout(900);
    await shot('results');
    await palette.getByRole('combobox').fill('zzqxv');
    await page.waitForTimeout(900);
    await shot('none');
    await context.close();
  }
}

if (parts.includes('tray')) {
  for (const theme of ['light', 'dark']) {
    const { context, page } = await open(theme, { width: 1440, height: 900 });
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('plus-tray').waitFor();
    await page.waitForTimeout(700);
    const b = await page.getByTestId('plus-tray').boundingBox();
    await page.screenshot({ path: `${OUT}/tray-${theme}.png`, clip: { x: b.x - 30, y: b.y - 30, width: b.width + 60, height: b.height + 140 } });
    await context.close();
  }
}
await browser.close();
console.log('captured', parts.join(', '), '->', OUT);
