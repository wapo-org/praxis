import {expect, type Locator, type Page} from '@playwright/test';
import type {FlowContext, WebFlow} from './flow-types.js';
import {sessionHeaders} from './session.js';

/** Reactive state settles once the fixture page has marked the account; this bounds a slow local backend. */
const CONNECTION_SETTLE_TIMEOUT_MS = 15_000;
const APP_COUNT = 7;

async function createChat({page, request, api}: FlowContext, title: string): Promise<{chatId: string; headers: {Authorization: string}}> {
  const headers = await sessionHeaders(page);
  const created = await request.post(`${api}/v1/chats`, {headers, data: {type: 'chat.input', title}});
  expect(created.ok()).toBe(true);
  const {id} = await created.json();
  return {chatId: String(id), headers};
}

/** The stand-in for Composio's hosted page (cloud/verify/auth/http.ts.template). */
async function allowOnFixturePage(page: Page, toolkit: string): Promise<void> {
  await expect(page.getByRole('heading', {name: `Connect ${toolkit}`})).toBeVisible();
  await page.getByRole('button', {name: 'Allow access'}).click();
}

async function openDirectory(page: Page): Promise<Locator> {
  await page.getByTestId('nav-settings-button').click();
  await page.getByRole('navigation', {name: 'Settings sections'}).getByRole('button', {name: 'App Directory', exact: true}).click();
  await expect(page).toHaveURL(/\/settings\/apps$/);
  const grid = page.getByRole('list', {name: 'Apps'});
  await expect(grid.getByRole('listitem')).toHaveCount(APP_COUNT);
  return grid;
}

async function themedScreenshots({page, screenshot, note}: FlowContext): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({colorScheme});
    note(`${colorScheme} screenshot: ${await screenshot(colorScheme)}`);
  }
  await page.emulateMedia({colorScheme: null});
}

const appDirectoryConnect: WebFlow = {
  id: 'app-directory-connect',
  title: 'App Directory: keyboard search, popup connect, live Connected state, per-chat toggle and disconnect',
  default: true,
  session: 'shared',
  allow: [],
  async run(context) {
    const {page, request, api, note} = context;
    const {chatId, headers} = await createChat(context, 'App Directory verification');
    await page.goto(`/c/${chatId}`);
    const grid = await openDirectory(page);

    await page.getByRole('searchbox', {name: 'Search apps'}).focus();
    await page.keyboard.type('gmail');
    await expect(grid.getByRole('listitem')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(grid.getByRole('button', {name: 'Connect Gmail'})).toBeFocused();
    const opened = page.waitForEvent('popup');
    await page.keyboard.press('Enter');
    const popup = await opened;
    await allowOnFixturePage(popup, 'gmail');
    await popup.waitForEvent('close', {timeout: CONNECTION_SETTLE_TIMEOUT_MS});
    note('the connect popup returned to the app and closed itself');

    const card = grid.getByRole('listitem', {name: 'Gmail'});
    await expect(card.getByText('Connected', {exact: true})).toBeVisible({timeout: CONNECTION_SETTLE_TIMEOUT_MS});
    await expect(card).toMatchAriaSnapshot(`
      - listitem "Gmail":
        - heading "Gmail" [level=3]
        - paragraph: Read, search and send email
        - paragraph: Connected
        - button "Disconnect Gmail"
        - text: Use in this chat
        - switch "Use Gmail in this chat" [checked]
    `);

    const toggle = card.getByRole('switch', {name: 'Use Gmail in this chat'});
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => {
      const chat = await (await request.get(`${api}/v1/chats/${chatId}`, {headers})).json();
      return chat.disabledConnectorIds;
    }).toContain('composio:gmail');
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    note('the per-chat switch writes composio:gmail to disabledConnectorIds and back');

    await page.getByRole('searchbox', {name: 'Search apps'}).fill('');
    await themedScreenshots(context);

    await card.getByRole('button', {name: 'Disconnect Gmail'}).click();
    await expect(card.getByText('Not connected', {exact: true})).toBeVisible({timeout: CONNECTION_SETTLE_TIMEOUT_MS});
    note('disconnect returned the card to Not connected');
  },
};

function connectRequiredMessages(chatId: string) {
  const now = new Date().toISOString();
  const content = [
    {type: 'composio.connect-required', toolkits: [{toolkit: 'slack', connectorId: 'composio:slack'}]},
    {type: 'text', text: '{"code":"connection-required"}'},
  ];
  const message = (id: string, role: 'user' | 'assistant', parts: unknown[], sequence: number) => ({
    type: 'message', id, chatId, role, parts, createdAt: now, updatedAt: now, sequence,
  });
  return [
    message(`${chatId}-ask`, 'user', [{type: 'text', text: 'Post the summary to Slack'}], 1),
    message(`${chatId}-answer`, 'assistant', [
      {type: 'toolCall', callId: 'call-slack', name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: '{"tools":[]}'},
      {type: 'toolResult', callId: 'call-slack', name: 'COMPOSIO_MULTI_EXECUTE_TOOL', isError: true, content},
      {type: 'text', text: 'Connect Slack and I can post it.'},
    ], 2),
  ];
}

const appConnectCard: WebFlow = {
  id: 'app-connect-card',
  title: 'In-chat connect card: a blocked popup falls back to a full-page connect and returns to the chat',
  default: true,
  session: 'shared',
  allow: [],
  async run(context) {
    const {page, note} = context;
    const {chatId} = await createChat(context, 'Connect card verification');
    // The tool result is a fixture: the local API has no Composio key, so it never produces one itself.
    await page.route(`**/v1/chats/${chatId}/messages*`, route => route.fulfill({
      json: {type: 'page', items: connectRequiredMessages(chatId), nextCursor: null},
    }));
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.goto(`/c/${chatId}`);

    const card = page.getByRole('region', {name: 'Connect Slack'});
    await expect(card).toMatchAriaSnapshot(`
      - region "Connect Slack":
        - paragraph: This needs Slack.
        - paragraph: You sign in on Slack’s own page. Then send your request again.
        - button "Connect Slack"
    `);
    await themedScreenshots(context);
    await card.getByRole('button', {name: 'Connect Slack'}).click();
    await allowOnFixturePage(page, 'slack');
    await expect(page).toHaveURL(new RegExp(`/c/${chatId}\\?`));
    note('the blocked popup fell back to a full-page connect that came back to the chat route');

    await expect(page.getByTestId('app-connect-done-slack')).toContainText('Slack connected', {timeout: CONNECTION_SETTLE_TIMEOUT_MS});
    const grid = await openDirectory(page);
    await grid.getByRole('button', {name: 'Disconnect Slack'}).click();
    await expect(grid.getByRole('button', {name: 'Connect Slack'})).toBeVisible({timeout: CONNECTION_SETTLE_TIMEOUT_MS});
  },
};

export const APP_FLOWS: readonly WebFlow[] = [appDirectoryConnect, appConnectCard];
