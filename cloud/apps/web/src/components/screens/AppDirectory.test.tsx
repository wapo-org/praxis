// @vitest-environment jsdom
import type { Chat } from '@praxis/protocol';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConnect } from '../../hooks/useAppConnect';
import type { AppConnections } from '../../hooks/useAppConnections';
import type { PraxisStoreContextValue } from '../../state/store.js';
import { AppDirectoryScreen } from './AppDirectoryScreen';

let store: PraxisStoreContextValue;
let connections: AppConnections;
let actions: AppConnect;
vi.mock('../../state/store.js', () => ({ usePraxisStore: () => store }));
vi.mock('../../hooks/useAppConnections', () => ({ useAppConnections: () => connections }));
vi.mock('../../hooks/useAppConnect', () => ({ useAppConnect: () => actions }));

const chat: Chat = {
  type: 'chat', id: 'c1', title: 'Chat', pinned: false, mode: 'ask', connectorIds: [],
  disabledConnectorIds: ['composio:github'], createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
} as Chat;

let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  store = { activeChat: chat, setChatApp: vi.fn().mockResolvedValue(undefined) } as unknown as PraxisStoreContextValue;
  connections = {
    state: 'ready',
    byToolkit: new Map([['gmail', 'connected'], ['github', 'connected'], ['slack', 'failed'], ['notion', 'pending']]),
  };
  actions = { busy: null, error: null, connect: vi.fn(), disconnect: vi.fn() };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => root.render(<AppDirectoryScreen />));
}
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const cards = () => [...container.querySelectorAll('[data-testid^="app-card-"]')];

describe('App Directory', () => {
  it('shows each app with the action its connection state allows', async () => {
    await mount();
    expect(cards()).toHaveLength(7);
    expect(container.querySelector('ul[aria-label="Apps"]')).not.toBeNull();
    expect(button('Disconnect Gmail')).not.toBeNull();
    expect(button('Reconnect Slack')).not.toBeNull();
    expect(button('Continue connecting Notion')).not.toBeNull();
    expect(button('Connect Linear')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-card-slack"]')!.textContent).toContain('Needs reconnecting');
    await act(async () => button('Connect Linear')!.click());
    expect(actions.connect).toHaveBeenCalledWith('linear');
    await act(async () => button('Disconnect Gmail')!.click());
    expect(actions.disconnect).toHaveBeenCalledWith('gmail');
  });

  it('filters by the search text and says when nothing matches', async () => {
    await mount();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type('calendar');
    expect(cards().map((card) => card.getAttribute('data-testid'))).toEqual(['app-card-googlecalendar']);
    await type('fax machine');
    expect(cards()).toHaveLength(0);
    expect(container.querySelector('[role="status"]')!.textContent).toContain('fax machine');
  });

  it('toggles a connected app for the open chat with composio connector ids', async () => {
    await mount();
    const gmail = container.querySelector<HTMLInputElement>('input[aria-label="Use Gmail in this chat"]')!;
    const github = container.querySelector<HTMLInputElement>('input[aria-label="Use GitHub in this chat"]')!;
    expect(gmail.checked).toBe(true);
    expect(github.checked).toBe(false);
    await act(async () => gmail.click());
    expect(store.setChatApp).toHaveBeenCalledWith('c1', 'gmail', false);
  });

  it('explains the chat toggle without an open chat, and fails closed while connections are unknown', async () => {
    store = { ...store, activeChat: null } as PraxisStoreContextValue;
    await mount();
    expect(container.querySelector('input[role="switch"]')).toBeNull();
    expect(container.textContent).toContain('Open a chat to turn Gmail on or off there.');

    connections = { state: 'error' };
    await mount();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Couldn’t load your connections');
    expect(button('Connect Gmail')!.disabled).toBe(true);
  });

  it('shows a connect failure and marks the app being connected', async () => {
    actions = { ...actions, busy: 'linear', error: 'Toolkit is already connected' };
    await mount();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Toolkit is already connected');
    expect(button('Connect Linear')!.textContent).toBe('Opening…');
    expect(button('Connect Linear')!.disabled).toBe(true);
  });
});
