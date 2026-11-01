// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CapabilitiesSchema, ModelSchema } from '@praxis/protocol';
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
const model = (id: string) => ModelSchema.parse({ type: 'model', id, providerId: 'p', displayName: id, capabilities: { serverWebSearch: true }, reasoningEfforts: ['low', 'high'], pinned: false, favorite: false });
it('round-trips chat and every settings sub-page through route paths', () => {
  for (const [sheet] of Object.entries(sheetPaths)) expect(parseRoute(pathForSheet(sheet as never, null, null)).sheet).toBe(sheet);
  expect(parseRoute('/c/private%20chat')).toEqual({ chatId: 'private chat', sheet: null, valid: true });
  expect(parseRoute('/settings/providers/new').providerId).toBeNull();
  expect(parseRoute('/settings/providers/p').providerId).toBe('p');
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
  const css = readFileSync(join(__dirname, 'styles/theme.css'), 'utf8');
  const native = [...swift.matchAll(/static let (\w+) = c\(0x([\dA-F]+), 0x([\dA-F]+)\)/g)];
  expect(native.length).toBe(13);
  for (const [, name, light, dark] of native) {
    const token = name!.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/(\d)/g, '-$1');
    expect(css.toLowerCase()).toContain(`--paper-${token}: #${light!.toLowerCase()}`);
    expect(css.toLowerCase()).toContain(`--paper-${token}: #${dark!.toLowerCase()}`);
  }
  expect(css).toContain('--paper-accent: var(--paper-ink)');
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
it('shows iOS tray order and sends the supported Web search toggle to the API', async () => {
  vi.spyOn(apiClient, 'bootstrap').mockRejectedValue(new Error('Offline'));
  vi.spyOn(apiClient, 'createChat').mockResolvedValue({ type: 'chat', id: 'new', title: 'New chat', mode: 'build', pinned: false, connectorIds: [], disabledConnectorIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  vi.spyOn(apiClient, 'patchChat').mockResolvedValue({} as never);
  const start = vi.spyOn(apiClient, 'startRun').mockRejectedValue(new Error('Run unavailable'));
  let store!: ReturnType<typeof usePraxisStore>;
  function Probe() { store = usePraxisStore(); return <PlusTray onPickFiles={() => {}} />; }
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const node = document.createElement('div'); root = createRoot(node);
  await act(async () => root!.render(<PraxisStoreProvider><Probe /></PraxisStoreProvider>));
  await act(async () => { store.cacheModels([model('hosted')]); store.setSelectedModel('p', 'hosted'); store.setPlusTrayOpen(true); });
  const groups = [...node.querySelectorAll('[role="group"]')];
  expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Mode', 'Reasoning effort']);
  expect([...node.querySelectorAll('.tray-media button')].map(n => n.textContent)).toEqual(['Photos', 'Camera', 'Files', 'Screenshot']);
  await act(async () => node.querySelector<HTMLInputElement>('[aria-label="Web search"]')!.click());
  await act(async () => store.sendMessage('Question'));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ webSearch: true }));
  await act(async () => { store.cacheModels([{ ...model('no-search'), capabilities: CapabilitiesSchema.parse({}) }]); store.setSelectedModel('p', 'no-search'); });
  expect(node.querySelector<HTMLInputElement>('[aria-label="Web search"]')!.disabled).toBe(true);
});
