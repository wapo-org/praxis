// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSettings } from './components/screens/AccountSettings';
import { AccountContext, type AccountSession } from './lib/account';
import { PraxisApiClient } from './lib/api';
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
it('omits password from the wire body for a blank OAuth confirmation', async () => {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ type: 'account.deleted' })),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const client = new PraxisApiClient({ baseUrl: 'https://api.example' });
    const { confirm } = await open((password) => client.deleteAccount(password));
    await act(async () => confirm.click());
    const [, request] = fetcher.mock.calls[0]!;
    expect(request?.method).toBe('DELETE');
    expect(JSON.parse(request?.body as string)).toEqual({ type: 'account.delete' });
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  [403, 'confirmation_required', 'Confirm your current password or sign in again', ''],
  [429, 'rate_limited', 'Too many account deletion attempts', 'hunter2-password'],
] as const)(
  'shows the API message and preserves confirmation after %i',
  async (status, code, message, password) => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ code, message }, { status })),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const client = new PraxisApiClient({ baseUrl: 'https://api.example' });
      const { confirmBlock, input, confirm } = await open((value) => client.deleteAccount(value));
      if (password) act(() => type(input, password));
      await act(async () => confirm.click());
      expect(confirmBlock.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect(document.querySelector('[data-testid="delete-account-confirm"]')).toBe(confirmBlock);
      expect(input.value).toBe(password);
      if (status === 429) {
        const [, request] = fetcher.mock.calls[0]!;
        expect(request?.body).toBe(JSON.stringify({ type: 'account.delete', password }));
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
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
