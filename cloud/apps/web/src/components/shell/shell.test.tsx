// @vitest-environment jsdom
import type { Chat } from '@praxis/protocol';
import { Icon, ICON_STROKE } from '@praxis/glass';
import { Plus as LucidePlus } from 'lucide-react';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupChats } from '../../lib/chatGroups';
import type { PraxisStoreContextValue } from '../../state/store';
import { ChatHeader } from '../chat/ChatHeader';
import { Sidebar } from './Sidebar';

let store: PraxisStoreContextValue;
vi.mock('../../state/store', () => ({ usePraxisStore: () => store }));

const NOW = new Date('2026-11-01T12:00:00Z');
const chat = (id: string, updatedAt: string, pinned = false): Chat => ({
  type: 'chat',
  id,
  title: `Chat ${id}`,
  pinned,
  mode: 'ask',
  connectorIds: [],
  disabledConnectorIds: [],
  createdAt: updatedAt,
  updatedAt,
});
const chats = [
  chat('today', '2026-11-01T10:00:00Z'),
  chat('yesterday', '2026-10-31T09:00:00Z'),
  chat('old', '2026-09-01T09:00:00Z'),
  chat('pinned', '2026-09-02T09:00:00Z', true),
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  store = {
    chats,
    activeChatId: 'today',
    activeChat: chats[0],
    desktopSidebarOpen: true,
    models: [],
    selectedModelId: null,
    selectedProviderId: null,
    setDesktopSidebarOpen: vi.fn(),
    startNewConversation: vi.fn(),
    setActiveSheet: vi.fn(),
    selectChat: vi.fn(async () => {}),
    renameChat: vi.fn(async () => {}),
    togglePinChat: vi.fn(async () => {}),
    deleteChats: vi.fn(async () => {}),
  } as unknown as PraxisStoreContextValue;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('chat grouping', () => {
  it('groups newest-first by date with pinned first and filters by title', () => {
    expect(groupChats(chats, '', NOW).map((g) => [g.group, g.chats.map((c) => c.id)])).toEqual([
      ['Pinned', ['pinned']],
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Older', ['old']],
    ]);
    expect(groupChats(chats, 'YESTER', NOW).map((g) => g.group)).toEqual(['Yesterday']);
  });
});

describe('Sidebar', () => {
  it('renders new chat, search, date groups and the account entry', () => {
    act(() => root.render(<Sidebar />));
    const sections = [...container.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['Pinned', 'Today', 'Yesterday', 'Older']);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Chat today');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')!.click());
    expect(store.startNewConversation).toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-account"]')!.click());
    expect(store.setActiveSheet).toHaveBeenCalledWith('settings');
  });

  it('filters chats from the search field and selects a chat', async () => {
    act(() => root.render(<Sidebar />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'old');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const titles = [...container.querySelectorAll('[data-sidebar-row-select]')].map((b) => b.textContent);
    expect(titles).toEqual(['Chat old']);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sidebar-row-select]')!.click());
    expect(store.selectChat).toHaveBeenCalledWith('old');
  });

  it('collapses and renders nothing when closed', () => {
    act(() => root.render(<Sidebar />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]')!.click());
    expect(store.setDesktopSidebarOpen).toHaveBeenCalledWith(false);
    store = { ...store, desktopSidebarOpen: false };
    act(() => root.render(<Sidebar key="closed" />));
    expect(container.querySelector('[data-testid="app-sidebar"]')).toBeNull();
  });
});

describe('ChatHeader', () => {
  it('has no Lab button and offers the sidebar toggle only while the sidebar is collapsed', () => {
    const open = renderToStaticMarkup(<ChatHeader />);
    expect(open).not.toMatch(/Lab/);
    expect(open).not.toContain('nav-sidebar-button');
    expect(open).toContain('nav-history-button');
    expect(open).toContain('nav-settings-button');
    store = { ...store, desktopSidebarOpen: false };
    expect(renderToStaticMarkup(<ChatHeader />)).toContain('nav-sidebar-button');
  });
});

describe('Icon', () => {
  it('enforces the token stroke and a scale size', () => {
    const html = renderToStaticMarkup(<Icon icon={LucidePlus} size={16} />);
    expect(html).toContain(`stroke-width="${ICON_STROKE}"`);
    expect(html).toContain('width="16"');
    expect(html).toContain('aria-hidden="true"');
  });
});
