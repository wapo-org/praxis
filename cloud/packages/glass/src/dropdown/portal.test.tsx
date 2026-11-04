// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlassDropdown } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const menu = (portal?: boolean) => (
  <GlassDropdown defaultOpen portal={portal}>
    <GlassDropdown.Trigger>Open</GlassDropdown.Trigger>
    <GlassDropdown.Content>
      <GlassDropdown.Item>Row</GlassDropdown.Item>
    </GlassDropdown.Content>
  </GlassDropdown>
);
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

it('portals to document.body by default, so no ancestor can clip the menu', async () => {
  const root = createRoot(host);
  await act(async () => root.render(menu()));
  const node = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(host.contains(node)).toBe(false);
  expect(node.style.position).toBe('fixed');
  await act(async () => root.unmount());
});

it('stays inline when a sheet asks for it, to remain inside its focus trap', async () => {
  const root = createRoot(host);
  await act(async () => root.render(menu(false)));
  expect(host.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => root.unmount());
});
