// @vitest-environment jsdom
import type { ModelListItem } from '@praxis/protocol';
import type { AppConnections } from '../../hooks/useAppConnections';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api';
import { PraxisStoreProvider, usePraxisStore } from '../../state/store';
import { buildModelRows, MODEL_ROW_HEIGHT } from './ModelList';
import { PlusTray } from './PlusTray';

let connections: AppConnections = { state: 'ready', byToolkit: new Map() };
vi.mock('../../hooks/useAppConnections', () => ({ useAppConnections: () => connections }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Model = ModelListItem;
const model = (id: string, pinned = false, name = id, recommended = false): Model => ({
  type: 'catalogModel',
  id,
  name,
  contextLength: 200000,
  maxOutput: 64000,
  pricing: { prompt: '0.000003', completion: '0.000015' },
  capabilities: { tools: true, reasoning: true, images: true, files: false },
  pinned,
  favorite: false,
  recommended,
});
const page = (items: Model[], nextCursor: string | null = null) => ({ type: 'page', items, nextCursor }) as never;

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof usePraxisStore>;
const picks = vi.fn();
function Probe() {
  store = usePraxisStore();
  return (
    <div data-testid="composer-dock">
      <button data-testid="composer-plus-button" />
      <PlusTray onPickFiles={picks} />
    </div>
  );
}
const query = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const options = () => [...document.querySelectorAll('[role="option"]')].map((n) => n.textContent);
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};
const press = async (key: string, target: EventTarget = document) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};
async function openTray(models: Model[] = [model('a', true)]) {
  await act(async () => {
    store.cacheModels(models);
    store.setSelectedModel(models[0]!.id);
    store.setPlusTrayOpen(true);
  });
}
async function openList() {
  await act(async () => query<HTMLButtonElement>('[data-testid="tray-model-picker-trigger"]')!.click());
  await flush();
}
async function openApps() {
  await act(async () => query<HTMLButtonElement>('[data-testid="tray-apps-trigger"]')!.click());
  await flush();
}
async function mountBootstrap(connected: string[]) {
  connections = { state: 'ready', byToolkit: new Map(connected.map((toolkit) => [toolkit, 'connected'])) };
  await act(async () => root.unmount());
  const now = new Date().toISOString();
  const chat = { type: 'chat', id: 'c1', title: 'Chat', mode: 'build', pinned: false, connectorIds: [], disabledConnectorIds: [], createdAt: now, updatedAt: now };
  vi.spyOn(apiClient, 'bootstrap').mockResolvedValue({
    type: 'bootstrap',
    protocolVersion: 1,
    user: { type: 'user', id: 'u', name: 'U' },
    chats: [chat],
    models: [model('a', true)],
    providers: [],
    connectors: [],
    skills: [],
    activeRuns: [],
    syncCursor: 'first',
    syncRoot: 'root',
    serverTime: now,
  } as never);
  vi.spyOn(apiClient, 'listMessages').mockResolvedValue(page([]));
  root = createRoot(host);
  await act(async () =>
    root.render(
      <PraxisStoreProvider>
        <Probe />
      </PraxisStoreProvider>,
    ),
  );
  await act(async () => store.refreshAll());
}

beforeEach(async () => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  vi.spyOn(apiClient, 'bootstrap').mockRejectedValue(new Error('Offline'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <PraxisStoreProvider>
        <Probe />
      </PraxisStoreProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('composer tray', () => {
  it('follows the iOS order and has no "Allow Photos access" on web', async () => {
    await openTray();
    const tray = query('[data-testid="plus-tray"]')!;
    expect(tray.textContent).not.toContain('Allow Photos');
    expect(tray.textContent).not.toContain('Your browser grants');
    const order = ['Auto', 'Execute'];
    expect(tray.textContent!.indexOf(order[0]!)).toBeLessThan(tray.textContent!.indexOf('Photos'));
    expect(tray.textContent!.indexOf('Photos')).toBeLessThan(tray.textContent!.indexOf('Web tools'));
    expect(tray.textContent!.indexOf('Web tools')).toBeLessThan(tray.textContent!.indexOf('App Directory'));
    expect(tray.textContent!.indexOf('App Directory')).toBeLessThan(tray.textContent!.indexOf('Models & OpenRouter'));
  });

  it('opens the file picker with an image filter from the Photos tile', async () => {
    await openTray();
    await act(async () => query<HTMLButtonElement>('[data-testid="tray-tile-photos"]')!.click());
    expect(picks).toHaveBeenCalledWith('image/*', undefined);
  });

  it('moves connected apps into a nested view with search, per-chat switches and a Manage button', async () => {
    const patch = vi
      .spyOn(apiClient, 'patchChat')
      .mockImplementation(async (_id, change) => ({ id: 'c1', ...change }) as never);

    await mountBootstrap([]);
    await openTray();
    expect(query('[data-testid="tray-apps-trigger"]')!.textContent).toContain('None');
    await openApps();
    expect(query('[data-testid="tray-apps-empty"]')).not.toBeNull();
    await act(async () => query<HTMLButtonElement>('[data-testid="tray-apps-manage"]')!.click());
    expect(store.plusTrayOpen).toBe(false);
    expect(store.activeSheet).toBe('apps');

    await mountBootstrap(['gmail', 'github']);
    await openTray();
    expect(query('input[aria-label="Gmail"]')).toBeNull();
    expect(query('[data-testid="tray-apps-trigger"]')!.textContent).toContain('· 2');
    await act(async () => store.selectChat('c1'));
    await flush();
    await openApps();
    const toggle = query<HTMLInputElement>('input[aria-label="Gmail"]')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(patch).toHaveBeenCalledWith('c1', { connectorIds: [], disabledConnectorIds: ['composio:gmail'] });

    const search = query<HTMLInputElement>('input[aria-label="Search apps"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'git');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('[data-testid^="tray-app-row-"]')).toHaveLength(1);
    expect(query('[data-testid="tray-app-row-github"]')).not.toBeNull();

    await act(async () => query<HTMLButtonElement>('[data-testid="tray-apps-view"] button[aria-label="Back"]')!.click());
    expect(query('[data-testid="tray-apps-trigger"]')!.getAttribute('aria-expanded')).toBe('false');
    await openApps();
    await press('Escape');
    expect(query('[data-testid="tray-apps-trigger"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(store.plusTrayOpen).toBe(true);
  });

  it('closes on Escape and on an outside press, but not on the + button', async () => {
    await openTray();
    await act(async () => {
      query('[data-testid="composer-plus-button"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(store.plusTrayOpen).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(store.plusTrayOpen).toBe(false);
    await openTray();
    await press('Escape');
    expect(store.plusTrayOpen).toBe(false);
  });

  it('closes itself when it navigates to a Settings page', async () => {
    await openTray();
    const row = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="plus-tray"] button')].find(
      (n) => n.textContent?.includes('Models & OpenRouter'),
    )!;
    await act(async () => row.click());
    expect(store.plusTrayOpen).toBe(false);
    expect(store.activeSheet).toBe('models');
  });
});

describe('model list inside the tray', () => {
  it('shows the seeded models straight away, then the API catalog, and never "(0)"', async () => {
    let resolve!: (value: never) => void;
    vi.spyOn(apiClient, 'listModels').mockReturnValue(new Promise((r) => (resolve = r)));
    await openTray([model('seeded', true)]);
    await openList();
    expect(options()).toEqual([expect.stringContaining('seeded')]);
    await act(async () => resolve(page([model('seeded', true), model('from-api')])));
    await flush();
    expect(options().join()).toContain('from-api');
    expect(query('[role="listbox"]')!.textContent).toContain('All models · 1');
  });

  it('has no "All models" header when every model is pinned', async () => {
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(page([model('a', true), model('b', true)]));
    await openTray();
    await openList();
    const text = query('[role="listbox"]')!.textContent!;
    expect(text).toContain('Pinned');
    expect(text).not.toContain('All models');
  });

  it('selects with the keyboard from the search field and returns to the main page', async () => {
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(page([model('a', true), model('b')]));
    await openTray();
    await openList();
    const input = query<HTMLInputElement>('input[role="combobox"]')!;
    await press('ArrowDown', input);
    await press('ArrowDown', input);
    expect(input.getAttribute('aria-activedescendant')).toBe(
      query('[data-testid="model-option-b"]')!.id,
    );
    await press('Enter', input);
    await flush();
    expect(store.selectedModelId).toBe('b');
    expect(query('[data-testid="tray-model-picker-trigger"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape leaves the list first, then closes the tray', async () => {
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(page([model('a', true)]));
    await openTray();
    await openList();
    await press('Escape');
    expect(query('[data-testid="tray-model-picker-trigger"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(store.plusTrayOpen).toBe(true);
    await press('Escape');
    expect(store.plusTrayOpen).toBe(false);
  });

  it('pinning updates in place and keeps the loaded pages', async () => {
    const list = vi.spyOn(apiClient, 'listModels').mockResolvedValue(page([model('a', true), model('b')]));
    const pin = vi.spyOn(apiClient, 'updateModelPreference').mockResolvedValue({ type: 'modelPreference', modelId: 'b', pinned: true, favorite: false });
    await openTray();
    await openList();
    list.mockClear();
    await act(async () => query<HTMLButtonElement>('[aria-label="Pin b"]')!.click());
    await flush();
    expect(pin).toHaveBeenCalledWith({ modelId: 'b', pinned: true });
    expect(list).not.toHaveBeenCalled();
    expect(query('[aria-label="Unpin b"]')).not.toBeNull();
  });

  it('shows the context window and price from the catalogue under each model', async () => {
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(
      page([model('a', true), { ...model('free', false, 'Free One'), contextLength: 1048576, pricing: { prompt: '0', completion: '0' } }]),
    );
    await openTray();
    await openList();
    expect(query('[data-testid="model-option-a"]')!.textContent).toContain('200K context · $3 in · $15 out per 1M');
    expect(query('[data-testid="model-option-free"]')!.textContent).toContain('1.05M context · Free');
  });

  it('lists pinned, then recommended, then the rest', async () => {
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(
      page([model('pinned', true), model('pick', false, 'pick', true), model('other')]),
    );
    await openTray([model('pinned', true)]);
    await openList();
    const text = query('[role="listbox"]')!.textContent!;
    expect(text.indexOf('Pinned')).toBeLessThan(text.indexOf('Recommended'));
    expect(text.indexOf('Recommended')).toBeLessThan(text.indexOf('All models · 1'));
    expect(options().map((o) => o!.replace(/\d.*$/, ''))).toEqual(['pinned', 'pick', 'other']);
  });

  it('searches the catalogue on the server by what was typed', async () => {
    const list = vi
      .spyOn(apiClient, 'listModels')
      .mockImplementation(async (params) => page(params?.q === 'son' ? [model('vendor/sonnet', false, 'Sonnet')] : [model('a', true), model('b')]));
    await openTray();
    await openList();
    const input = query<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'son');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'son' }));
    expect(options()).toEqual([expect.stringContaining('Sonnet')]);
    expect(query('[role="listbox"]')!.textContent).not.toContain('All models');
  });

  it('mounts a small window of a 500-model catalog', async () => {
    const all = Array.from({ length: 500 }, (_, i) => model(`m${i}`));
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(page(all));
    await openTray();
    await openList();
    expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(40);
    const spacer = query<HTMLElement>('[role="listbox"]')!;
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(500 * MODEL_ROW_HEIGHT - 1);
  });
});

describe('buildModelRows', () => {
  it('puts recommended models in their own section between pinned and the rest', () => {
    const rows = buildModelRows([model('c'), model('r', false, 'r', true), model('a', true)], false, false);
    expect(rows.map((r) => (r.kind === 'label' ? r.text : r.kind === 'model' ? r.model.id : r.kind))).toEqual(['Pinned', 'a', 'Recommended', 'r', 'All models · 1', 'c']);
  });
  it('orders pinned before the rest and adds a load-more row when a cursor remains', () => {
    const rows = buildModelRows([model('b'), model('a', true)], false, true);
    expect(rows.map((r) => r.kind)).toEqual(['label', 'model', 'label', 'model', 'more']);
    expect(rows[1]).toMatchObject({ model: { id: 'a' } });
    expect(rows[2]).toMatchObject({ text: 'All models · 1+' });
  });
  it('is a flat result list while searching', () => {
    expect(buildModelRows([model('b'), model('a', true)], true, false).map((r) => r.kind)).toEqual(['model', 'model']);
  });
  it('stacks rows by their heights', () => {
    const rows = buildModelRows([model('a'), model('b')], false, false);
    expect(rows.map((r) => r.top)).toEqual([0, 32, 32 + MODEL_ROW_HEIGHT]);
  });
});

describe('shared search and dropdown actions', () => {
  it('offers exactly the same live model, mode, and reasoning option display labels and applies a keyboard choice', async () => {
    const { SearchPalette } = await import('../search/SearchPalette');
    const models = [
      { ...model('a', true, 'Alpha'), reasoningEfforts: ['low', 'medium', 'high', 'max'] },
      model('b', false, 'Beta'),
    ];
    vi.spyOn(apiClient, 'listModels').mockResolvedValue(page(models));
    await openTray(models);
    const modes = [...document.querySelectorAll('[aria-label="Mode"] button')].map(n => n.textContent);
    const efforts = [...document.querySelectorAll('[aria-label="Reasoning effort"] button')].map(n => n.textContent);
    expect(modes).toEqual(['Auto', 'Ask', 'Execute']); // WP-I1: Plan is gone, Build is Execute
    expect(efforts).toEqual(['Low', 'Medium', 'High']);
    await openList();
    await act(async () => {
      store.setPlusTrayOpen(false);
      root.render(<PraxisStoreProvider><Probe /><SearchPalette open onClose={() => {}} /></PraxisStoreProvider>);
    });
    const fillSearch = async (value: string) => {
      const input = query<HTMLInputElement>('[data-testid="search-palette"] input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return input;
    };
    let input = await fillSearch('Change model');
    await press('Enter', input);
    await flush();
    expect([...document.querySelectorAll('[data-testid="search-palette"] [role="option"]')].map(n => n.textContent)).toEqual(['Alpha', 'Beta']);
    await press('Escape', input);
    input = await fillSearch('Change mode');
    await press('ArrowDown', input);
    await press('Enter', input);
    expect([...document.querySelectorAll('[data-testid="search-palette"] [role="option"]')].map(n => n.textContent)).toEqual(modes);
    await press('Escape', input);
    input = await fillSearch('reasoning');
    await press('Enter', input);
    expect([...document.querySelectorAll('[data-testid="search-palette"] [role="option"]')].map(n => n.textContent)).toEqual(efforts);
    await press('ArrowDown', input);
    await press('Enter', input);
    expect(store.selectedEffort).toBe('medium');
  });
});
