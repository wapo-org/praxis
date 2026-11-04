// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSettings } from './components/screens/AccountSettings';
import { AccountContext, type AccountSession } from './lib/account';
import { setReplicaIdentity, wipeReplicaStorage } from './lib/idb';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});
async function open(deleteAccount: AccountSession['deleteAccount']) {
  await act(async () =>
    root.render(
      <AccountContext.Provider
        value={{
          userId: 'A',
          server: 'https://api.example',
          signOut: vi.fn(),
          deleteAccount,
          error: '',
          busy: false,
        }}
      >
        <AccountSettings />
      </AccountContext.Provider>,
    ),
  );
  await act(async () =>
    (document.querySelector('[data-testid="delete-account-row"]') as HTMLElement).click(),
  );
  const confirmBlock = document.querySelector('[data-testid="delete-account-confirm"]') as HTMLElement;
  const input = confirmBlock.querySelector('[data-testid="delete-account-password"]') as HTMLInputElement;
  const confirm = [...confirmBlock.querySelectorAll('button')].find(
    (b) => b.textContent === 'Delete account permanently',
  )!;
  return { confirmBlock, input, confirm };
}
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('confirms deletion inline: explains the loss and sends the typed password', async () => {
  const deleteAccount = vi.fn().mockResolvedValue(undefined);
  const { confirmBlock, input, confirm } = await open(deleteAccount);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(confirmBlock.textContent).toContain('chats and messages');
  expect(confirmBlock.textContent).toContain("can't be undone");
  expect(confirmBlock.textContent).toContain('Delete your account?');
  act(() => type(input, 'hunter2-password'));
  await act(async () => confirm.click());
  expect(deleteAccount).toHaveBeenCalledWith('hunter2-password');
});
it("shows the API's own message, including rate limiting, and keeps the confirm open", async () => {
  const deleteAccount = vi.fn().mockRejectedValue(Error('Too many account deletion attempts'));
  const { confirmBlock, confirm } = await open(deleteAccount);
  await act(async () => confirm.click());
  expect(confirmBlock.querySelector('[role="alert"]')?.textContent).toBe(
    'Too many account deletion attempts',
  );
  expect(document.querySelector('[data-testid="delete-account-confirm"]')).not.toBeNull();
});
it('wipes every local replica database and owner marker', async () => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
  await setReplicaIdentity('https://api.example', 'A');
  localStorage.setItem('praxis-theme', 'dark');
  const deleted: string[] = [];
  const request = () => {
    const req: Record<string, (() => void) | null> = { onsuccess: null, onerror: null };
    queueMicrotask(() => req.onerror?.());
    return req;
  };
  vi.stubGlobal('indexedDB', {
    open: request,
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req: Record<string, (() => void) | null> = { onsuccess: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
  try {
    await wipeReplicaStorage();
    expect(deleted).toEqual(['praxis-cloud-scoped-v2', 'praxis-cloud-idb']);
    expect([...items.keys()]).toEqual(['praxis-theme']);
  } finally {
    vi.unstubAllGlobals();
  }
});
