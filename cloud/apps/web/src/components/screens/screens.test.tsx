// @vitest-environment jsdom
import type { Chat, Connector, Model, Provider, Skill } from '@praxis/protocol';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api.js';
import type { PraxisStoreContextValue } from '../../state/store.js';
import { ConnectorsScreen, parseConnectorConfig } from './ConnectorsScreen.js';
import { ConsentSheet } from './ConsentSheet.js';
import { HistorySheet } from './HistorySheet.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { SheetDialog } from './ScreenUI.js';
import { ProviderEditor, SettingsSheet } from './SettingsSheet.js';
import { SheetsRoot } from './SheetsRoot.js';
import { SkillsScreen } from './SkillsScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';

let store: PraxisStoreContextValue;
vi.mock('../../state/store.js', () => ({ usePraxisStore: () => store }));

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
const provider = {
  type: 'provider',
  id: 'provider-1',
  name: 'Example',
  flavor: 'openAIChat',
  baseUrl: 'https://example.com/v1',
  maskedKey: 'sk-…1234',
  capabilities: {},
  updatedAt: now,
} as Provider;
const connector: Connector = {
  type: 'connector',
  id: 'connector-1',
  name: 'Docs',
  url: 'https://example.com/mcp',
  transport: 'streamableHttp',
  enabled: true,
  trusted: false,
  disabledTools: [],
  authStatus: 'connected',
  updatedAt: now,
};
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
    connectors: [],
    connectorTools: {},
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
    editingProviderId: null,
    setActiveSheet: vi.fn(),
    setEditingProviderId: vi.fn(),
    setDesktopSidebarOpen: vi.fn(),
    setThemeMode: vi.fn(),
    setPendingConsentPrompt: vi.fn(),
    selectChat: vi.fn().mockResolvedValue(undefined),
    createNewChat: vi.fn().mockResolvedValue(chat('new')),
    renameChat: vi.fn().mockResolvedValue(undefined),
    togglePinChat: vi.fn().mockResolvedValue(undefined),
    deleteChats: vi.fn().mockResolvedValue(undefined),
    saveProvider: vi.fn().mockResolvedValue(provider),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    refreshModelsForProvider: vi.fn().mockResolvedValue([]),
    loadConnectorTools: vi.fn().mockResolvedValue([]),
    setConnectorToolEnabled: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    updateConnector: vi.fn().mockResolvedValue(undefined),
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
  await act(async () => root.render(<div className="screen-shell">{element}</div>));
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

describe('remote connector import', () => {
  it('accepts URLs and Claude/Cursor configs, preserving SSE and bearer tokens', () => {
    expect(parseConnectorConfig('https://example.com/mcp')).toEqual([
      {
        name: 'example.com',
        url: 'https://example.com/mcp',
        transport: 'streamableHttp',
      },
    ]);
    expect(
      parseConnectorConfig(
        JSON.stringify({
          mcpServers: {
            Docs: {
              url: 'https://example.com/sse',
              type: 'sse',
              headers: { Authorization: 'Bearer test-token' },
            },
          },
        }),
      ),
    ).toEqual([
      {
        name: 'Docs',
        url: 'https://example.com/sse',
        transport: 'sse',
        token: 'test-token',
      },
    ]);
  });
  it('rejects local commands, malformed configs, and unsupported headers before import', () => {
    expect(() => parseConnectorConfig('{')).toThrow('valid JSON');
    expect(() => parseConnectorConfig('{"mcpServers":{}}')).toThrow('no servers');
    expect(() => parseConnectorConfig('{"mcpServers":{"Local":{"command":"npx"}}}')).toThrow(
      'only remote servers',
    );
    expect(() =>
      parseConnectorConfig(
        '{"mcpServers":{"Docs":{"url":"https://example.com","headers":{"X-API-Key":"secret"}}}}',
      ),
    ).toThrow('only an Authorization');
    expect(() =>
      parseConnectorConfig('{"mcpServers":{"Docs":{"url":"file:///tmp/server"}}}'),
    ).toThrow('HTTP or HTTPS');
  });
});

describe('history interactions', () => {
  it('groups pinned chats and deletes exactly the selected chat IDs', async () => {
    store.chats = [chat('one', true), chat('two')];
    await mount(<HistorySheet />);
    expect(document.querySelector('section[aria-label="Pinned"]')?.textContent).toContain(
      'Chat one',
    );
    expect(document.querySelector('section[aria-label="Today"]')?.textContent).toContain(
      'Chat two',
    );
    await click(button('History options'));
    // The menu lives outside the scrolling body, within the focus-trapped sheet.
    expect(document.querySelector('[role="menu"]')?.parentElement?.className).toBe('screen-shell');
    await click(button('Select chats'));
    await click(document.querySelector<HTMLInputElement>('[aria-label="Select Chat two"]')!);
    await click(button('Delete selected (1)'));
    expect(store.deleteChats).toHaveBeenCalledWith(['two']);
  });
  it('keeps history open and shows a useful failure if opening a chat fails', async () => {
    store.chats = [chat('one')];
    store.selectChat = vi.fn().mockRejectedValue(new Error('Could not load this chat'));
    const close = vi.fn();
    await mount(<HistorySheet onSelect={close} />);
    await click(document.querySelector<HTMLButtonElement>('.screen-history-select')!);
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
  });
});

describe('connector health status', () => {
  it('uses the API health field and never infers Connected from authStatus', async () => {
    store.connectors = [{ ...connector, authStatus: 'none' }];
    await mount(<ConnectorsScreen />);
    expect(container.textContent).toContain('Status unknown');
    expect(container.textContent).not.toContain('Connected');
    for (const [status, label] of [
      ['connected', 'Connected'],
      ['unreachable', 'Unreachable'],
      ['needs_auth', 'Needs auth'],
      ['needs_reauth', 'Needs reauth'],
      ['error', 'Error'],
    ] as const) {
      store.connectors = [{ ...connector, status }];
      await mount(<ConnectorsScreen />);
      expect(container.textContent).toContain(label);
    }
  });
});

describe('settings and capabilities', () => {
  it('navigates to providers and tools, and updates the appearance preference', async () => {
    await mount(<SettingsSheet />);
    await click(button('Add provider'));
    expect(store.setEditingProviderId).toHaveBeenCalledWith(null);
    expect(store.setActiveSheet).toHaveBeenCalledWith('provider-editor');
    await click(button('Light'));
    expect(store.setThemeMode).toHaveBeenCalledWith('light');
    await click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.screen-nav-row')).find((node) =>
        node.textContent?.includes('Connectors'),
      )!,
    );
    expect(store.setActiveSheet).toHaveBeenCalledWith('connectors');
  });
  it('preserves saved secrets when editing a provider and leaves verification failures visible', async () => {
    store.providers = [provider];
    store.editingProviderId = provider.id;
    vi.spyOn(apiClient, 'testProvider').mockResolvedValue({
      type: 'provider.test.result',
      ok: false,
      models: [],
      message: 'Invalid credentials',
    });
    await mount(<ProviderEditor />);
    await click(button('Test connection'));
    expect(store.saveProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() }),
    );
    expect(store.saveProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({ extraHeaders: expect.anything() }),
    );
    expect(store.refreshModelsForProvider).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid credentials');
    expect(store.setActiveSheet).not.toHaveBeenCalled();
  });
  it('persists edited endpoint capabilities and offers an iOS preset picker', async () => {
    store.providers = [provider];
    store.editingProviderId = provider.id;
    await mount(<ProviderEditor />);
    expect(document.querySelector('[aria-label="Provider preset"]')?.tagName).toBe('BUTTON');
    const tools = [...document.querySelectorAll<HTMLInputElement>('[role="switch"]')].find((n) =>
      n.closest('label')?.textContent?.includes('Tool calling'),
    )!;
    await click(tools);
    await click(button('Save provider'));
    expect(store.saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: expect.objectContaining({ tools: true }),
      }),
    );
  });
  it('clears saved headers only after an explicit edit', async () => {
    store.providers = [{ ...provider, headerNames: ['X-Account'] }];
    store.editingProviderId = provider.id;
    await mount(<ProviderEditor />);
    await click(button('Clear saved headers'));
    await click(button('Save provider'));
    expect(store.saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: provider.id, extraHeaders: {} }),
    );
  });
  it('loads a connector’s tools on expansion and persists a per-tool toggle', async () => {
    store.connectors = [connector];
    store.connectorTools = {
      [connector.id]: [
        {
          type: 'tool.spec',
          name: 'search',
          description: 'Search docs',
          inputSchema: {},
          source: { type: 'mcp' },
          traits: ['readOnly'],
        },
      ],
    };
    await mount(<ConnectorsScreen />);
    await click(document.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!);
    expect(store.loadConnectorTools).toHaveBeenCalledWith(connector.id);
    const searchToggle = Array.from(
      document.querySelectorAll<HTMLInputElement>('[role="switch"]'),
    ).find((node) => node.closest('label')?.textContent?.includes('Search docs'))!;
    await click(searchToggle);
    expect(store.setConnectorToolEnabled).toHaveBeenCalledWith(connector.id, 'search', false);
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
  it('separates verified and unknown vision models while excluding text-only models', async () => {
    store.providers = [provider];
    store.models = [true, null, false].map(
      (supportsImages, index) =>
        ({
          id: `model-${index}`,
          displayName: `Model ${index}`,
          providerId: provider.id,
          supportsImages,
        }) as Model,
    );
    await mount(<ImageReaderScreen />);
    expect(document.body.textContent).toContain('Verified vision support');
    expect(document.body.textContent).toContain('Unverified vision support');
    expect(document.body.textContent).not.toContain('Model 2');
    await click(button('Model 1model-1'));
    expect(store.updatePreferences).toHaveBeenCalledWith({
      vision: { enabled: true, providerId: provider.id, modelId: 'model-1' },
    });
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

describe('sheet and consent lifecycle', () => {
  it('shows consent independently of activeSheet and calls only the chosen callback', async () => {
    const allow = vi.fn();
    const cancel = vi.fn();
    store.pendingConsentPrompt = {
      host: 'voice.example.com',
      purpose: 'voice',
      description: 'Share recorded audio.',
      onAllow: allow,
      onCancel: cancel,
    };
    await mount(<SheetsRoot />);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'AI data sharing',
    );
    expect(document.querySelector('#consentTitle')?.textContent).toContain('recording');
    expect(document.body.textContent).toContain('voice.example.com');
    expect(document.body.textContent).not.toContain('Your messages');
    await click(button('Allow'));
    expect(allow).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
  it('cancels consent on Escape', async () => {
    const cancel = vi.fn();
    store.pendingConsentPrompt = {
      host: 'example.com',
      purpose: 'chat',
      description: 'Share this chat.',
      onAllow: vi.fn(),
      onCancel: cancel,
    };
    await mount(<ConsentSheet />);
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(store.setPendingConsentPrompt).toHaveBeenCalledWith(null);
  });
  it('isolates the background, traps keyboard focus, and restores focus on unmount', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const dismiss = vi.fn();
    await mount(
      <SheetDialog label="Test sheet" onDismiss={dismiss}>
        <button>First</button>
        <button>Last</button>
      </SheetDialog>,
    );
    expect(container.inert).toBe(true);
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    // jsdom has no layout; expose the two controls as visible to the focus trap.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
      () => [{ width: 10, height: 10 }] as unknown as DOMRectList,
    );
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    );
    expect(document.activeElement?.textContent).toBe('First');
    button('Last').focus();
    await act(async () =>
      button('Last').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    );
    expect(document.activeElement?.textContent).toBe('First');
    await mount(null);
    expect(container.inert).toBeFalsy();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
