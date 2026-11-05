// WP-D2 visual gate: tray (main, model list, search), each Settings section, and a dropdown opened
// at a viewport edge; 1440×900 and 402×874; light and dark; plus boards next to the iOS references.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5196';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/D2`;
const REF = new URL('../../../docs/web/reference/ios/', import.meta.url).pathname;
const ONLY = process.env.ONLY?.split(',');
const want = (name) => !ONLY || ONLY.some((o) => name.includes(o));
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 402, height: 874 } };
const SECTIONS = {
  root: '/settings',
  general: '/settings/general',
  models: '/settings/providers',
  'provider-new': '/settings/providers/new',
  'image-reader': '/settings/images',
  voice: '/settings/voice',
  connectors: '/settings/connectors',
  'connector-url': '/settings/connectors/add',
  'connector-config': '/settings/connectors/config',
  skills: '/settings/skills',
  'skill-import': '/settings/skills/import',
  data: '/settings/sharing',
  account: '/settings/account',
  developer: '/settings/developer',
};

// A catalog of 60 models, so the list, its sections and its badges show the real layout.
const CATALOG = Array.from({ length: 60 }, (_, i) => ({
  type: 'model',
  id: `model-${i}`,
  providerId: 'scripted',
  displayName: ['Claude 3.7 Sonnet', 'GPT-4.1 Turbo', 'Gemini 2.5 Pro', 'Llama 4 Maverick (Extended context)'][i % 4] + ` #${i + 1}`,
  tagline: ['Fast and thorough', 'Great for everyday work', 'Deep reasoning for hard problems', ''][i % 4] || undefined,
  capabilities: { type: 'capabilities', tools: true, parallelToolCalls: i % 2 === 0, vision: i % 3 === 0, documents: false, imagesInToolResults: false, reasoningEffort: i % 2 === 0, streamUsage: true, explicitPromptCaching: false, serverWebSearch: i % 4 === 0, midConversationSystem: false, serverCompaction: false, toolSearch: false },
  reasoningEfforts: ['low', 'medium', 'high'],
  pinned: i < 2,
  favorite: false,
}));
async function open(theme, viewport, path = '/') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  const signIn = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([signIn.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await signIn.isVisible()) await signIn.click();
  await page.getByTestId('chat-top-bar').waitFor();
  if (path !== '/') await page.goto(`${BASE}${path}`);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
const settle = (page) => page.waitForTimeout(450);

for (const theme of ['light', 'dark'])
  for (const [vpName, viewport] of Object.entries(viewports)) {
    const tag = `${vpName}-${theme}`;
    if (want('tray')) {
      const { context, page } = await open(theme, viewport);
      await page.route('**/v1/models?**', async (route) => {
        const q = new URL(route.request().url()).searchParams.get('q')?.toLowerCase() ?? '';
        await route.fulfill({ json: { type: 'page', items: CATALOG.filter((m) => m.displayName.toLowerCase().includes(q)), nextCursor: null } });
      });
      await page.getByTestId('composer-plus-button').click();
      await page.getByTestId('plus-tray').waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-tray.png`) });
      await page.getByTestId('tray-model-picker-trigger').click();
      await page.getByRole('listbox', { name: 'Models' }).getByRole('option').first().waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-tray-models.png`) });
      await page.getByPlaceholder('Search models…').fill('sonnet');
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(OUT, `${tag}-tray-search.png`) });
      await context.close();
    }
    for (const [name, path] of Object.entries(SECTIONS)) {
      if (!want(`settings-${name}`)) continue;
      const { context, page } = await open(theme, viewport, path);
      await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-settings-${name}.png`) });
      await context.close();
    }
    if (want('tray-chat')) {
      // A real chat behind the glass, with a connector: the row toggles and no ghost text.
      const { context, page } = await open(theme, viewport);
      await page.evaluate(async () => {
        const { apiClient } = await import('/src/lib/api.ts');
        const boot = await apiClient.bootstrap();
        if (!boot.connectors.length) await apiClient.createConnector({ name: 'Docs MCP', url: 'https://mcp.does-not-exist.invalid/mcp' });
      });
      await page.reload();
      await page.getByTestId('composer-input').fill('Write three long paragraphs so the glass has text behind it.');
      await page.getByTestId('composer-input').press('Enter');
      await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
      await page.getByTestId('composer-plus-button').click();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-tray-chat.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      if (vpName === 'desktop') {
        const row = page.locator('[data-testid="app-sidebar"] [data-testid="history-row"]').first();
        await row.hover();
        await row.getByRole('button', { name: /^Actions for/ }).click();
        await page.getByRole('menu').waitFor();
        await settle(page);
        await page.screenshot({ path: join(OUT, `${tag}-sidebar-menu.png`) });
      }
      await context.close();
    }
    if (want('sheet-menu')) {
      const { context, page } = await open(theme, viewport, '/settings/providers/new');
      await settle(page); // Let the sheet finish entering, so the click doesn't scroll it.
      await page.getByRole('button', { name: 'Provider preset', exact: true }).click();
      await page.getByRole('menu').waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-sheet-menu.png`) });
      await context.close();
    }
    if (want('delete-sheet')) {
      const { context, page } = await open(theme, viewport, '/settings/account');
      await page.getByTestId('delete-account-row').click();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-delete-sheet.png`) });
      await context.close();
    }
    if (want('consent')) {
      const { context, page } = await open(theme, viewport);
      // Sign in as a fresh user first: the session only applies to requests after the reload.
      await page.evaluate(async (user) => {
        await (await import('/src/lib/dev-auth.ts')).devAuth(user);
      }, `d2-consent-${theme}-${vpName}-${Date.now()}`);
      await page.reload();
      await page.getByTestId('chat-top-bar').waitFor();
      const provider = await page.evaluate(async () => {
        const { apiClient } = await import('/src/lib/api.ts');
        return apiClient.createProvider({ name: 'Test provider', flavor: 'openAIChat', baseUrl: 'https://consent.invalid/v1', defaultModel: 'consent-model' });
      });
      // A new provider has no catalog until a real endpoint answers, so stub its one model.
      await page.route('**/v1/models?**', (route) => route.fulfill({ json: { type: 'page', items: [{ ...CATALOG[0], id: 'consent-model', displayName: 'consent-model', providerId: provider.id }], nextCursor: null } }));
      await page.reload();
      await page.getByTestId('composer-plus-button').click();
      await page.getByTestId('tray-model-picker-trigger').click();
      await page.getByRole('option', { name: /consent-model/ }).first().click();
      await page.getByTestId('tray-model-picker-trigger').getByText('consent-model').waitFor();
      await page.keyboard.press('Escape');
      await page.getByTestId('composer-input').fill('Hello');
      await page.getByTestId('composer-input').press('Enter');
      await page.getByTestId('consentTitle').waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-consent.png`) });
      await context.close();
    }
    if (want('menu-edge') && vpName === 'desktop') {
      // A real menu: the chat row's actions at the bottom-left, plus the lab's edge triggers.
      const { context, page } = await open(theme, viewport);
      await page.goto(`${BASE}/lab/glass?dropdown`);
      for (const anchor of ['bottom-end', 'top-start']) {
        await page.getByTestId(`position-${anchor}`).click();
        await page.getByRole('menu').waitFor();
        await settle(page);
        await page.screenshot({ path: join(OUT, `${tag}-menu-edge-${anchor}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
      await context.close();
    }
    if (want('menu-edge') && vpName === 'mobile') {
      const { context, page } = await open(theme, viewport);
      await page.goto(`${BASE}/lab/glass?dropdown`);
      await page.getByTestId('position-bottom-end').click();
      await page.getByRole('menu').waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `${tag}-menu-edge-bottom-end.png`) });
      await context.close();
    }
  }

// Side-by-side boards: web (desktop, narrow) next to the iOS reference.
const pairs = {
  tray: 'tray-2-main',
  consent: 'consent-0-sheet',
  'tray-models': 'tray-0-models-top',
  'settings-root': 'settings-0-root',
  'settings-connectors': 'settings-2-connectors',
  'settings-connector-url': 'settings-3-add-url',
  'settings-connector-config': 'settings-4-paste-config',
  'settings-skills': 'settings-5-skills',
  'settings-image-reader': 'settings-6-image-reader',
  'settings-provider-new': 'settings-7-editor-top',
};
if (!ONLY || ONLY.includes('boards')) {
  const board = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const dataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  for (const theme of ['light', 'dark'])
    for (const [state, ref] of Object.entries(pairs)) {
      const imgs = await Promise.all([
        dataUrl(join(OUT, `desktop-${theme}-${state}.png`)),
        dataUrl(join(OUT, `mobile-${theme}-${state}.png`)),
        dataUrl(join(REF, `${theme}-${ref}.png`)),
      ]);
      await board.setContent(`<body style="margin:0;display:flex;gap:16px;align-items:flex-start;padding:16px;background:#888;font:12px system-ui">
        <figure style="margin:0"><img src="${imgs[0]}" style="height:560px"><figcaption>web 1440</figcaption></figure>
        <figure style="margin:0"><img src="${imgs[1]}" style="height:560px"><figcaption>web 402</figcaption></figure>
        <figure style="margin:0"><img src="${imgs[2]}" style="height:560px"><figcaption>iOS ${theme}-${ref}</figcaption></figure></body>`);
      await board.screenshot({ path: join(OUT, `compare-${theme}-${state}.png`), fullPage: true });
    }
}
await browser.close();
console.log(JSON.stringify({ out: OUT }));
