// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelListItemSchema } from '@praxis/protocol';
import { apiClient } from './lib/api';
import { parseRoute, pathForSheet, sheetPaths } from './lib/navigation';
import { useModelSearch } from './lib/useModelSearch';
import { workedLabel } from './components/chat/useActivityClock';
import { AgentMessageView } from './components/chat/AgentMessageView';
import { PlusTray } from './components/chat/PlusTray';
import { PraxisStoreProvider, usePraxisStore } from './state/store';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const model = (id: string) => ModelListItemSchema.parse({ type: 'catalogModel', id, name: id, contextLength: 128000, pricing: { prompt: '0.000003', completion: '0.000015' }, capabilities: { tools: true, reasoning: true, images: false }, pinned: false, favorite: false, recommended: false });
const modelKey = { type: 'modelKey' as const, maskedKey: '••••1234', connectedAt: '2026-11-15T10:00:00.000Z' };
it('round-trips chat and every settings sub-page through route paths', () => {
  for (const [sheet] of Object.entries(sheetPaths)) expect(parseRoute(pathForSheet(sheet as never, null)).sheet).toBe(sheet);
  expect(parseRoute('/c/private%20chat')).toEqual({ chatId: 'private chat', sheet: null, valid: true });
  expect(parseRoute('/settings/models')).toEqual({ sheet: 'models', valid: true });
  expect(parseRoute('/settings/openrouter/callback')).toEqual({ sheet: 'openrouter-callback', valid: true });
  expect(parseRoute('/settings/providers').valid).toBe(false);
  expect(parseRoute('/settings/providers/new').valid).toBe(false);
  expect(parseRoute('/missing').valid).toBe(false);
  expect(parseRoute('/c/%xx').valid).toBe(false);
});
it('uses real timestamps for Worked for Ns and does not invent missing duration', () => {
  expect(workedLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z')).toBe('Worked for 3s');
  expect(workedLabel()).toBe('Worked');
  expect(workedLabel('invalid', 'invalid')).toBe('Worked');
});
it('renders GFM strikethrough and SVG icons', () => {
  const html = renderToStaticMarkup(<AgentMessageView text="Use ~~Soft~~ and `inline`" />);
  expect(html).toContain('<del>Soft</del>'); expect(html).toContain('<svg');
});
it('matches the native light/dark palette and monochrome primary action aliases', () => {
  // Relative to this file, so it passes from the cloud root and from the web workspace alike.
  const swift = readFileSync(join(__dirname, '../../../../PraxisChat/PraxisChat/DesignSystem/Tokens.swift'), 'utf8');
  const css = readFileSync(join(__dirname, 'styles/tokens.css'), 'utf8').toLowerCase();
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('\n}', css.indexOf(`${selector} {`)));
  const light = block("[data-theme='light']");
  const dark = block("[data-theme='dark']");
  const native = [...swift.matchAll(/static let (\w+) = c\(0x([\dA-F]+), 0x([\dA-F]+)\)/g)];
  expect(native.length).toBe(13);
  // Maps native token names to web CSS equivalents.
  const web: Record<string, string> = {
    canvas: '--color-paper', card: '--color-surface', ink: '--color-ink', secondaryInk: '--color-ink-2',
    mutedInk: '--color-ink-3', fill1: '--color-fill-1', fill2: '--color-fill-2',
    success: '--color-success', destructive: '--color-danger',
  };
  for (const [, name, l, d] of native) {
    const token = web[name!];
    if (!token) continue;
    expect(light).toContain(`${token}: #${l!.toLowerCase()};`);
    expect(dark).toContain(`${token}: #${d!.toLowerCase()};`);
  }
  expect(light).toContain('--color-accent: #15140f;');
  expect(dark).toContain('--color-accent: #f1efe9;');
  expect(css).toContain('--paper-accent: var(--color-accent)');
});
it('debounces server model search, loads cursors, and ignores stale responses', async () => {
  vi.useFakeTimers();
  const list = vi.spyOn(apiClient, 'listModels').mockResolvedValueOnce({ type: 'page', items: [model('first')], nextCursor: 'page2' })
    .mockResolvedValueOnce({ type: 'page', items: [model('beyond-bootstrap')], nextCursor: null });
  let result!: ReturnType<typeof useModelSearch>;
  function Probe({ q }: { q: string }) { result = useModelSearch(q, true); return null; }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe q="r" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await act(async () => root!.render(<Probe q="remote" />));
  expect(list).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(list).toHaveBeenCalledWith({ q: 'remote', cursor: undefined, limit: 50 });
  await act(async () => result.loadMore());
  expect(list).toHaveBeenLastCalledWith({ q: 'remote', cursor: 'page2', limit: 50 });
  expect(result.items.map(m => m.id)).toEqual(['first', 'beyond-bootstrap']);
  let finish!: (value: never) => void;
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root!.render(<Probe q="old" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  list.mockResolvedValueOnce({ type: 'page', items: [model('new')], nextCursor: null });
  await act(async () => root!.render(<Probe q="new" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => finish({ type: 'page', items: [model('old')], nextCursor: null } as never));
  expect(result.items.map(m => m.id)).toEqual(['new']);
});
it('shows iOS tray order, offers reasoning effort from the catalogue entry, and toggles web tools per chat', async () => {
  vi.spyOn(apiClient, 'bootstrap').mockRejectedValue(new Error('Offline'));
  const created = { type: 'chat' as const, id: 'new', title: 'New chat', mode: 'build' as const, pinned: false, connectorIds: [], disabledConnectorIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  vi.spyOn(apiClient, 'createChat').mockResolvedValue(created);
  const patch = vi.spyOn(apiClient, 'patchChat').mockImplementation(async (_id, changes) => ({ ...created, ...changes }));
  const start = vi.spyOn(apiClient, 'startRun').mockRejectedValue(new Error('Run unavailable'));
  let store!: ReturnType<typeof usePraxisStore>;
  function Probe() { store = usePraxisStore(); return <PlusTray onPickFiles={() => {}} />; }
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const node = document.createElement('div'); root = createRoot(node);
  await act(async () => root!.render(<PraxisStoreProvider><Probe /></PraxisStoreProvider>));
  vi.spyOn(apiClient, 'connectModelKey').mockResolvedValue(modelKey);
  await act(async () => { await store.connectModelKey({ method: 'paste', apiKey: 'sk-or-v1-test' }); store.cacheModels([model('hosted')]); store.setSelectedModel('hosted'); store.setPlusTrayOpen(true); });
  const groups = [...node.querySelectorAll('[role="group"]')];
  expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Mode', 'Reasoning effort']);
  expect([...node.querySelectorAll('[data-testid^="tray-tile-"]')].map(n => n.textContent)).toEqual(['Photos', 'Camera', 'Files', 'Screenshot']);
  // Web tools are a persisted chat setting, so the switch waits for the chat to exist.
  expect(node.querySelector<HTMLInputElement>('[aria-label="Web tools"]')!.disabled).toBe(true);
  await act(async () => { await store.sendMessage('Question'); });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'hosted' }));
  expect(start.mock.calls[0]![0]).not.toHaveProperty('webSearch');
  const webSwitch = () => node.querySelector<HTMLInputElement>('[aria-label="Web tools"]')!;
  expect(webSwitch().disabled).toBe(false);
  expect(webSwitch().checked).toBe(true);
  await act(async () => { webSwitch().click(); });
  expect(patch).toHaveBeenCalledWith('new', { webToolsEnabled: false });
  expect(webSwitch().checked).toBe(false);
  expect(start.mock.calls[0]![0]).not.toHaveProperty('providerId');
  await act(async () => { store.cacheModels([{ ...model('plain'), capabilities: { tools: true, reasoning: false, images: false, files: false } }]); store.setSelectedModel('plain'); });
  expect([...node.querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'))).toEqual(['Mode']);
});
