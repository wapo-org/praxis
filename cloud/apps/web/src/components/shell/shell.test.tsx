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
import { ComposerBar } from '../chat/ComposerBar';
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
    activeSheet: null,
    desktopSidebarOpen: true,
    plusTrayOpen: false,
    inlineModelSearchActive: false,
    activeLiveRun: null,
    models: [],
    selectedModelId: null,
    selectedProviderId: null,
    setDesktopSidebarOpen: vi.fn(),
    setPlusTrayOpen: vi.fn(),
    startNewConversation: vi.fn(),
    setActiveSheet: vi.fn(),
    selectChat: vi.fn(async () => {}),
    renameChat: vi.fn(async () => {}),
    togglePinChat: vi.fn(async () => {}),
    deleteChats: vi.fn(async () => {}),
    cancelActiveRun: vi.fn(async () => {}),
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
  it('renders new chat, search, date groups and the account entry without a Praxis wordmark', () => {
    act(() => root.render(<Sidebar />));
    const header = container.querySelector('[data-testid="sidebar-toggle"]')?.parentElement;
    expect(header?.textContent).toBe('New chat');
    const sections = [...container.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['Pinned', 'Today', 'Yesterday', 'Older']);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Chat today');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-chat"]')!.click());
    expect(store.startNewConversation).toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-account"]')!.click());
    expect(store.setActiveSheet).toHaveBeenCalledWith('settings');
  });

  it('swaps immediately into settings sections without a Settings title header and keeps back + collapse controls', () => {
    store = { ...store, activeSheet: 'settings' };
    act(() => root.render(<Sidebar />));
    const back = container.querySelector<HTMLButtonElement>('[data-testid="settings-back"]');
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]');
    expect(back).not.toBeNull();
    expect(back?.textContent).toBe('Back');
    expect(toggle).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-new-chat"]')).toBeNull();
  });

  it('opens floating search on request and still selects history rows', async () => {
    const open = vi.fn();
    window.addEventListener('praxis:search', open);
    act(() => root.render(<Sidebar />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Search conversations"]')!.click());
    expect(open).toHaveBeenCalledOnce();
    expect(container.querySelector('input')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sidebar-row-select]')!.click());
    expect(store.selectChat).toHaveBeenCalledWith('pinned');
    window.removeEventListener('praxis:search', open);
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

describe('ComposerBar', () => {
  it('has no camera button, uses translucent secondary controls, and swaps mic to send when typing', () => {
    const inputRef = React.createRef<HTMLTextAreaElement>();
    act(() =>
      root.render(
        <ComposerBar
          inputRef={inputRef}
          text=""
          onTextChange={() => {}}
          onKeyDown={() => {}}
          recording={false}
          transcribing={false}
          onToggleVoice={() => {}}
          onSend={() => {}}
          attachmentCount={0}
        />,
      ),
    );
    expect(container.querySelector('.composer-camera')).toBeNull();
    expect(container.querySelector('[aria-label="Camera"]')).toBeNull();

    const voice = container.querySelector<HTMLButtonElement>('[data-testid="composer-voice-button"]')!;
    const send = container.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]')!;
    expect(voice.getAttribute('data-hidden')).toBeNull();
    expect(send.getAttribute('data-hidden')).toBe('true');

    act(() =>
      root.render(
        <ComposerBar
          inputRef={inputRef}
          text="Hello"
          onTextChange={() => {}}
          onKeyDown={() => {}}
          recording={false}
          transcribing={false}
          onToggleVoice={() => {}}
          onSend={() => {}}
          attachmentCount={0}
        />,
      ),
    );
    expect(voice.getAttribute('data-hidden')).toBe('true');
    expect(send.getAttribute('data-hidden')).toBeNull();
    expect(send.disabled).toBe(false);
  });
});

describe('ChatHeader', () => {
  it('has no Lab button and offers the sidebar toggle only while the sidebar is collapsed', () => {
    const open = renderToStaticMarkup(<ChatHeader />);
    expect(open).not.toMatch(/Lab/);
    expect(open).not.toContain('nav-sidebar-button');
    expect(open).toContain('nav-settings-button');
    store = { ...store, desktopSidebarOpen: false };
    expect(renderToStaticMarkup(<ChatHeader />)).toContain('nav-sidebar-button');
  });
  it('shows History instead on narrow screens, and renders no empty glass for the other size', () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const narrow = renderToStaticMarkup(<ChatHeader />);
    expect(narrow).toContain('nav-history-button');
    expect(narrow).not.toContain('nav-settings-button');
    expect(narrow.match(/data-glass-surface/g)).toHaveLength(2); // history, new chat: the title has no box (WP-K2, K-ref/13)
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
