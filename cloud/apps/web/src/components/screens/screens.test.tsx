// @vitest-environment jsdom
import type { Chat, ModelListItem as Model, Skill } from '@praxis/protocol';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api.js';
import type { PraxisStoreContextValue } from '../../state/store.js';
import { Sidebar } from '../shell/Sidebar.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { SidebarSettings } from '../shell/SidebarSettings';
import { SettingsPage } from './SettingsPage.js';
import { GeneralSection, ModelsSection } from './SettingsSections.js';
import { SkillsScreen } from './SkillsScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';

let store: PraxisStoreContextValue;
vi.mock('../../state/store.js', () => ({ usePraxisStore: () => store }));
vi.mock('../../hooks/useAppConnections', () => ({ useAppConnections: () => ({ state: 'ready', byToolkit: new Map() }) }));
vi.mock('../../hooks/useAppConnect', () => ({
  useAppConnect: () => ({ busy: null, error: null, connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('../../hooks/useAppCatalog', () => ({
  useAppCatalog: () => ({
    state: 'ready',
    items: [],
    totalItems: 0,
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useCloseWindow', () => ({ useCloseWindow: () => undefined }));

let container: HTMLDivElement;
let root: Root;
const now = new Date().toISOString();
const chat = (id: string, pinned = false): Chat => ({
  type: 'chat',
  id,
  title: `Chat ${id}`,
  pinned,
  mode: 'ask',
  connectorIds: [],
  disabledConnectorIds: [],
  createdAt: now,
  updatedAt: now,
});
const skill: Skill = {
  type: 'skill',
  id: 'skill-1',
  name: 'Research',
  description: 'Research a topic',
  document: '# Research',
  enabled: true,
  updatedAt: now,
};

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
});

beforeEach(() => {
  store = {
    chats: [],
    activeChatId: null,
    messagesByChat: {},
    providers: [],
    models: [],
    skills: [],
    registries: [],
    registryEntries: {},
    consents: [],
    attachmentsById: {},
    preferences: null,
    themeMode: 'system',
    hydrated: true,
    activeSheet: null,
    pendingConsentPrompt: null,
    desktopSidebarOpen: false,
    setActiveSheet: vi.fn(),
    setDesktopSidebarOpen: vi.fn(),
    setThemeMode: vi.fn(),
    setPendingConsentPrompt: vi.fn(),
    selectChat: vi.fn().mockResolvedValue(undefined),
    createNewChat: vi.fn().mockResolvedValue(chat('new')),
    renameChat: vi.fn().mockResolvedValue(undefined),
    togglePinChat: vi.fn().mockResolvedValue(undefined),
    deleteChats: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    saveSkill: vi.fn().mockResolvedValue(skill),
    updatePreferences: vi.fn().mockResolvedValue(undefined),
    grantConsent: vi.fn().mockResolvedValue(undefined),
  } as unknown as PraxisStoreContextValue;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount(element: React.ReactNode) {
  await act(async () => root.render(<div>{element}</div>));
}
function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('history in the floating sidebar', () => {
  it('groups pinned chats first and opens the dedicated search surface', async () => {
    store.chats = [chat('one', true), chat('two')];
    store.desktopSidebarOpen = true;
    await mount(<Sidebar />);
    expect(document.querySelector('section[aria-label="Pinned"]')?.textContent).toContain(
      'Chat one',
    );
    expect(document.querySelector('section[aria-label="Today"]')?.textContent).toContain(
      'Chat two',
    );
    const open = vi.fn();
    window.addEventListener('praxis:search', open);
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Search conversations"]')!);
    expect(open).toHaveBeenCalledOnce();
    window.removeEventListener('praxis:search', open);
  });
  it('shows a useful failure if opening a chat fails', async () => {
    store.chats = [chat('one')];
    store.desktopSidebarOpen = true;
    store.selectChat = vi.fn().mockRejectedValue(new Error('Could not load this chat'));
    await mount(<Sidebar />);
    await click(document.querySelector<HTMLButtonElement>('[data-sidebar-row-select]')!);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
  });
});

describe('settings and capabilities', () => {
  it('navigates to providers and tools, and updates the appearance preference', async () => {
    await mount(<ModelsSection />);
    expect(container.textContent).toContain('OpenRouter');
    await mount(<GeneralSection />);
    await click(button('Light'));
    expect(store.setThemeMode).toHaveBeenCalledWith('light');
    await mount(<SidebarSettings sheet="settings" devTools={false} />);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-apps"]')!);
    expect(store.setActiveSheet).toHaveBeenCalledWith('apps');
  });
  it('labels every page after its section with no visible Settings page or sidebar header', async () => {
    const labelOf = () =>
      document.querySelector('[data-testid="settings-page"]')?.getAttribute('aria-label');
    const current = () => document.querySelector('[aria-current="page"]')?.textContent;
    for (const [sheet, title, nav] of [
      ['settings', 'General', 'General'],
      ['general', 'General', 'General'],
      ['models', 'Models', 'Models'],
      ['image-reader', 'Image reading model', 'Models'],
      ['apps', 'App Directory', 'App Directory'],
      ['app-connected', 'App connected', 'App Directory'],
      ['skills', 'Skills', 'Skills'],
      ['consents', 'Data & privacy', 'Data & privacy'],
      ['voice-settings', 'Voice input', 'General'],
    ] as const) {
      await mount(
        <>
          <SettingsPage sheet={sheet} />
          <SidebarSettings sheet={sheet} devTools={false} />
        </>,
      );
      expect(document.querySelector('header h1')).toBeNull();
      expect(labelOf()).toBe(title);
      expect(current()).toBe(nav);
    }
  });
  it('goes back to the parent page; the way out of Settings is the floating nav, not a Done button', async () => {
    await mount(<SettingsPage sheet="app-connected" />);
    await click(button('Back'));
    expect(store.setActiveSheet).toHaveBeenLastCalledWith('apps');
    await mount(<SettingsPage sheet="apps" />);
    expect(document.body.textContent).not.toContain('Done');
    expect(document.querySelector('[aria-label="Back"]')).toBeNull();
    expect(document.querySelector('[aria-label="Settings sections"]')).toBeNull();
    await mount(<SidebarSettings sheet="apps" devTools={false} />);
    await click(button('Close settings'));
    expect(store.setActiveSheet).toHaveBeenLastCalledWith(null);
  });
  it('preserves a skill document when disabling it', async () => {
    store.skills = [skill];
    await mount(<SkillsScreen />);
    await click(document.querySelector<HTMLInputElement>('[role="switch"]')!);
    expect(store.saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: skill.id,
        document: '# Research',
        enabled: false,
      }),
    );
  });
  it('lists only models whose catalogue entry takes images, and saves the choice by model id', async () => {
    const entry = (id: string, images: boolean) =>
      ({
        type: 'catalogModel',
        id,
        name: `Model ${id}`,
        contextLength: 128000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        capabilities: { tools: true, reasoning: false, images, files: false },
        pinned: false,
        favorite: false,
        recommended: false,
      }) as Model;
    vi.spyOn(apiClient, 'listModels').mockResolvedValue({
      type: 'page',
      items: [entry('sees', true), entry('blind', false)],
      nextCursor: null,
    });
    await mount(<ImageReaderScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.body.textContent).toContain('Model sees');
    expect(document.body.textContent).toContain('128K context · $1 in · $2 out per 1M');
    expect(document.body.textContent).not.toContain('Model blind');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Model sees'))!);
    expect(store.updatePreferences).toHaveBeenCalledWith({ vision: { enabled: true, modelId: 'sees' } });
  });
  it('saves voice options without replacing an omitted key', async () => {
    await mount(<VoiceSettingsScreen />);
    await click(document.querySelector<HTMLInputElement>('input[value="whisper-large-v3"]')!);
    const language = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(
      (node) => node.placeholder === 'Detect automatically',
    )!;
    await fill(language, 'pl');
    await click(button('Save voice settings'));
    expect(store.updatePreferences).toHaveBeenCalledWith({
      voice: { model: 'whisper-large-v3', language: 'pl' },
    });
  });
});
