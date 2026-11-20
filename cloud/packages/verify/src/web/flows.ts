import assert from 'node:assert/strict';
import {expect, type Locator, type Page} from '@playwright/test';
import {previewProviderFlow, unavailableAccountFlow} from './auth-flows.js';
import {APP_FLOWS} from './app-flows.js';
import {browserCliFlow} from './browser-flow.js';
import {fuzzChatFlow} from './fuzz.js';
import type {FlowContext, WebFlow} from './flow-types.js';
import {sessionHeaders} from './session.js';

/** Vite serves web sources as modules, so a flow can drive the real client the app uses. */
const API_MODULE = '/src/lib/api.ts';
const SCRIPTED_MODEL_NAMES = ['Praxis Scripted', 'Praxis Vision'];
const TOOL_RUNS_MAX = 30;
/** A scripted tool run settles in milliseconds locally; this only bounds a slow CI runner. */
const RUN_SETTLE_TIMEOUT_MS = 10_000;

interface ApiModule {
  apiClient: {
    createSkill(input: {name: string; description: string; document: string}): Promise<unknown>;
    bootstrap(): Promise<unknown>;
  };
}

function composer(page: Page) {
  return page.getByRole('textbox', {name: 'Message Praxis'});
}

const loadApp: WebFlow = {
  id: 'load-app',
  title: 'The signed-in Convex Auth shell shows an empty chat with a usable composer',
  default: true,
  session: 'shared',
  allow: [],
  async run({page}) {
    await expect(page.getByRole('heading', {level: 1})).toBeVisible();
    await expect(composer(page)).toBeEditable();
  },
};

const settingsModels: WebFlow = {
  id: 'settings-models',
  title: 'Settings → Models shows the OpenRouter card, not connected',
  default: true,
  session: 'shared',
  allow: [],
  async run({page}) {
    await page.getByTestId('nav-settings-button').click();
    await page.getByRole('navigation', {name: 'Settings sections'}).getByRole('button', {name: 'Models', exact: true}).click();
    await expect(page.getByTestId('openrouter-disconnected')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Connect OpenRouter'})).toBeEnabled();
    await expect(page.getByRole('button', {name: 'Paste a key instead'})).toBeEnabled();
  },
};

const modelSearch: WebFlow = {
  id: 'model-search',
  title: 'Composer model list opens and its search narrows to the scripted models',
  default: true,
  session: 'shared',
  allow: [],
  async run({page}) {
    await page.getByRole('button', {name: 'Open attachments and controls'}).click();
    await page.getByTestId('tray-model-picker-trigger').click();
    const list = page.getByRole('listbox', {name: 'Models'});
    await expect(list.getByRole('option').first()).toBeVisible();
    await page.getByRole('combobox', {name: 'Search models'}).fill('Praxis');
    // The search is debounced and server-side; poll until the list settles on matches only.
    await expect.poll(async () => (await list.getByRole('option').allTextContents()).every(text => /praxis/i.test(text)), {message: 'search never narrowed the list to matching models'}).toBe(true);
    for (const name of SCRIPTED_MODEL_NAMES) await expect(list.getByRole('option', {name: new RegExp(`^${name}`)})).toBeVisible();
  },
};

const scriptedChat: WebFlow = {
  id: 'scripted-chat',
  title: 'Send a message on the scripted model and see the streamed reply',
  default: true,
  session: 'shared',
  allow: [],
  async run({page, note}) {
    const text = `Verify ${Date.now().toString(36)}`;
    await page.getByRole('button', {name: 'Open attachments and controls'}).click();
    await page.getByTestId('tray-model-picker-trigger').click();
    await page.getByRole('option', {name: /^Praxis Scripted/}).click();
    await page.keyboard.press('Escape');
    await composer(page).fill(text);
    await page.getByTestId('composer-send-button').click();
    const screen = page.getByTestId('chat-screen');
    await expect(screen.getByText(text, {exact: true})).toBeVisible();
    await expect(screen.getByText(`Scripted response: ${text}`)).toBeVisible();
    await expect(page.getByTestId('composer-stop-button')).toHaveCount(0);
    note(`reply streamed for "${text}"`);
  },
};

/** Opens a fresh Build chat, starts a scripted run that parks on the local write, and returns that write's card. */
async function parkedWrite({page, request, api}: FlowContext, title: string, text: string, script: string) {
  const headers = await sessionHeaders(page);
  const created = await request.post(`${api}/v1/chats`, {headers, data: {type: 'chat.input', title, mode: 'build'}});
  expect(created.ok()).toBe(true);
  const {id: chatId} = await created.json();
  await page.goto(`/c/${chatId}`);
  const started = await request.post(`${api}/v1/runs`, {headers, data: {type: 'run.start', chatId, text, script}});
  expect(started.ok()).toBe(true);
  const {id: runId} = await started.json();
  const card = page.locator('[data-testid^="approval-card-"]').filter({hasText: 'local write'});
  return {headers, runId: String(runId), card};
}

async function deny(card: Locator): Promise<void> {
  await card.getByRole('button', {name: 'Deny'}).click();
  await expect(card).toHaveCount(0);
}

const toolApproval: WebFlow = {
  id: 'tool-approval',
  title: 'A nested write shows its redacted preview and settles after denial',
  default: true,
  session: 'shared',
  allow: [],
  async run(context) {
    const {headers, runId, card} = await parkedWrite(context, 'Approval verification', 'Review a nested write', 'nestedApproval');
    await expect(card).toContainText('#review');
    await expect(card).toContainText('[redacted]');
    await expect(card).not.toContainText('scripted-preview-secret');
    await deny(card);
    await expect.poll(async () => {
      const response = await context.request.get(`${context.api}/v1/runs/${runId}/snapshot`, {headers});
      const snapshot = await response.json();
      return snapshot.run.status;
    }, {timeout: RUN_SETTLE_TIMEOUT_MS}).toBe('completed');
  },
};

const taintedApproval: WebFlow = {
  id: 'tainted-approval',
  title: 'A write after an untrusted read names the source on its approval card',
  default: true,
  session: 'shared',
  allow: [],
  async run(context) {
    const {card} = await parkedWrite(context, 'Taint verification', 'Read a page, then write', 'taintedApproval');
    await expect(card.getByTestId('approval-taint')).toHaveText('This run read content from local fetch.');
    await deny(card);
  },
};

/** Former `apps/web/scripts/p0-check.mjs`: failure paths must surface, never fabricate data or keep a dead session. */
const apiResilience: WebFlow = {
  id: 'api-resilience',
  title: 'Missing route errors, a 401 signs out, 30 tool runs keep the API alive',
  default: true,
  session: 'isolated',
  allow: [
    {kind: 'response', pattern: /^\/v1\/skills$/, status: 404, reason: 'the flow stubs a missing skills route'},
    {kind: 'response', pattern: /^\/v1\/bootstrap$/, status: 401, reason: 'the flow stubs an expired session'},
  ],
  async run({page, api, request, note}) {
    await page.route('**/v1/skills', route => route.fulfill({status: 404, body: '{}'}));
    const unavailable = await page.evaluate(async path => {
      const {apiClient} = (await import(path)) as ApiModule;
      try {
        await apiClient.createSkill({name: 'Ghost', description: '', document: ''});
        return 'FABRICATED';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, API_MODULE);
    assert.match(unavailable, /no longer available/);
    await toolRuns({api, request, note}, await sessionHeaders(page));
    await page.route('**/v1/bootstrap', route => route.fulfill({status: 401, body: '{}'}));
    await page.evaluate(async path => {
      const {apiClient} = (await import(path)) as ApiModule;
      await apiClient.bootstrap().catch(() => undefined);
    }, API_MODULE);
    await page.getByRole('button', {name: 'Sign in', exact: true}).waitFor();
    assert.equal(await page.getByTestId('chat-screen').count(), 0, 'chat stayed mounted after a 401');
  },
};

async function toolRuns({api, request, note}: Pick<FlowContext, 'api' | 'request' | 'note'>, headers: {Authorization: string}): Promise<void> {
  const chat = await (await request.post(`${api}/v1/chats`, {headers, data: {type: 'chat.input', title: 'praxis-verify tool runs'}})).json();
  for (let i = 0; i < TOOL_RUNS_MAX; i++) {
    const started = await request.post(`${api}/v1/runs`, {headers, data: {type: 'run.start', chatId: chat.id, text: 'Tools probe', script: 'tools'}});
    assert(started.ok(), `run ${i}: HTTP ${started.status()} ${await started.text()}`);
    const run = await started.json();
    // One chat allows one active run; waiting for each to settle keeps the loop deterministic on slow runners.
    await expect.poll(async () => {
      const snapshot = await request.get(`${api}/v1/runs/${run.id}/snapshot`, {headers});
      assert(snapshot.ok(), `run ${i}: snapshot failed with HTTP ${snapshot.status()}`);
      return (await snapshot.json()).run.status;
    }, {message: `run ${i} never settled`, timeout: RUN_SETTLE_TIMEOUT_MS}).toMatch(/^(completed|failed|cancelled)$/);
  }
  assert((await request.get(`${api}/health`)).ok(), 'API unhealthy after tool runs');
  note(`${TOOL_RUNS_MAX} tool runs with snapshots`);
}

export const WEB_FLOWS: readonly WebFlow[] = [
  loadApp, settingsModels, modelSearch, scriptedChat, toolApproval, taintedApproval, apiResilience, browserCliFlow, fuzzChatFlow,
  unavailableAccountFlow, previewProviderFlow, ...APP_FLOWS,
];

export function selectFlows(ids: readonly string[] | undefined): WebFlow[] {
  if (!ids?.length) return WEB_FLOWS.filter(flow => flow.default);
  const unknown = ids.filter(id => !WEB_FLOWS.some(flow => flow.id === id));
  if (unknown.length) throw new Error(`Unknown flow ${unknown.join(', ')}; known: ${WEB_FLOWS.map(flow => flow.id).join(', ')}`);
  return ids.map(id => WEB_FLOWS.find(flow => flow.id === id)!);
}
