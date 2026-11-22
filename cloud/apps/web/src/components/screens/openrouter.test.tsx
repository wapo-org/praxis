// @vitest-environment jsdom
import type { ModelKey } from '@praxis/protocol';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatContext, formatCredit, formatPrice } from '../../lib/models.js';
import { beginOpenRouterConnect, challengeFor, takeVerifier } from '../../lib/openrouter-pkce.js';
import type { PraxisStoreContextValue } from '../../state/store.js';
import { OpenRouterCallback } from './OpenRouterCallback.js';
import { OpenRouterCard } from './OpenRouterCard.js';

let store: PraxisStoreContextValue;
vi.mock('../../state/store.js', () => ({ usePraxisStore: () => store }));

const VERIFIER_KEY = 'praxis.openrouter.pkce-verifier';
const ACCOUNT_KEY = 'praxis.openrouter.pkce-account';
const connected: ModelKey = {
  type: 'modelKey',
  maskedKey: '••••AAAA',
  label: 'sk-or-v1-aaa...AAA',
  connectedAt: '2026-11-15T10:00:00.000Z',
  limit: 25,
  limitRemaining: 19.5,
};
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  sessionStorage.clear();
  store = {
    user: { id: 'account-a' },
    modelKey: null,
    setActiveSheet: vi.fn(),
    connectModelKey: vi.fn().mockResolvedValue(connected),
    checkModelKey: vi.fn().mockResolvedValue(connected),
    disconnectModelKey: vi.fn().mockResolvedValue(undefined),
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

const mount = (element: React.ReactNode) => act(async () => root.render(element));
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const text = () => container.textContent ?? '';
function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}
const click = (element: HTMLElement) => act(async () => element.click());
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('OpenRouter card', () => {
  it('not connected: explains, offers Connect and a paste fallback, and shows no key', async () => {
    await mount(<OpenRouterCard />);
    expect(container.querySelector('[data-testid="openrouter-disconnected"]')).not.toBeNull();
    expect(button('Connect OpenRouter')).toBeTruthy();
    expect(button('Paste a key instead')).toBeTruthy();
    expect(container.querySelector('[data-testid="openrouter-connected"]')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(text()).not.toContain('Disconnect');
  });

  it('Connect stores a verifier and leaves for OpenRouter with an S256 challenge and the web callback', async () => {
    const navigate = vi.fn();
    await mount(<OpenRouterCard navigate={navigate} />);
    await click(button('Connect OpenRouter'));
    await settle();
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe(`${window.location.origin}/settings/openrouter/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const verifier = sessionStorage.getItem(VERIFIER_KEY)!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toBe(await challengeFor(verifier));
    expect(url.toString()).not.toContain(verifier);
    expect(store.connectModelKey).not.toHaveBeenCalled();
  });

  it('paste: sends the trimmed key, then clears and closes the form', async () => {
    await mount(<OpenRouterCard />);
    await click(button('Paste a key instead'));
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(button('Save key').disabled).toBe(true);
    await fill(input, '  sk-or-v1-pasted-key  ');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await settle();
    expect(store.connectModelKey).toHaveBeenCalledWith({ method: 'paste', apiKey: 'sk-or-v1-pasted-key' });
    expect(container.querySelector('input')).toBeNull();
  });

  it('paste: shows OpenRouter\'s message when the key is rejected and keeps the form open', async () => {
    store.connectModelKey = vi.fn().mockRejectedValue(new Error('OpenRouter did not accept this key. OpenRouter said: User not found.'));
    await mount(<OpenRouterCard />);
    await click(button('Paste a key instead'));
    await fill(container.querySelector<HTMLInputElement>('input')!, 'sk-or-v1-bad');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await settle();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('OpenRouter said: User not found.');
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('connected: shows the masked key, label and remaining credit, with Check and Disconnect', async () => {
    store.modelKey = connected;
    await mount(<OpenRouterCard />);
    const row = container.querySelector('[data-testid="openrouter-connected"]')!;
    expect(row.textContent).toContain('••••AAAA');
    expect(row.textContent).toContain('Connected');
    expect(text()).toContain('sk-or-v1-aaa...AAA');
    expect(text()).toContain('$19.50 of $25.00 left');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain('Connect OpenRouter');
    await click(button('Check'));
    await settle();
    expect(store.checkModelKey).toHaveBeenCalledTimes(1);
    await click(button('Disconnect'));
    await settle();
    expect(store.disconnectModelKey).toHaveBeenCalledTimes(1);
  });

  it('connected with no limit says so, and a failed check shows its error', async () => {
    store.modelKey = { ...connected, limit: null, limitRemaining: null };
    store.checkModelKey = vi.fn().mockRejectedValue(new Error('OpenRouter could not be reached. Try again shortly.'));
    await mount(<OpenRouterCard />);
    expect(text()).toContain('No limit on this key');
    await click(button('Check'));
    await settle();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('OpenRouter could not be reached');
  });

  it('error: a key OpenRouter rejected shows its message, a Needs attention badge and a way to reconnect', async () => {
    store.modelKey = { ...connected, lastError: 'User not found.' };
    await mount(<OpenRouterCard />);
    const alert = container.querySelector('[data-testid="openrouter-key-error"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('User not found.');
    expect(container.querySelector('[data-testid="openrouter-connected"]')!.textContent).toContain('Needs attention');
    expect(button('Reconnect OpenRouter')).toBeTruthy();
    expect(button('Paste a key instead')).toBeTruthy();
    expect(button('Disconnect')).toBeTruthy();
  });
});

describe('PKCE helper', () => {
  it('makes a fresh verifier per attempt and hands it out exactly once', async () => {
    const first = await beginOpenRouterConnect('account-a', 'https://app.example');
    const firstVerifier = sessionStorage.getItem(VERIFIER_KEY);
    const second = await beginOpenRouterConnect('account-a', 'https://app.example');
    expect(new URL(second).searchParams.get('callback_url')).toBe('https://app.example/settings/openrouter/callback');
    expect(second).not.toBe(first);
    const verifier = takeVerifier('account-a');
    expect(verifier).not.toBe(firstVerifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
    expect(takeVerifier('account-a')).toBeNull();
  });
  it('derives the RFC 7636 example challenge', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('OpenRouter callback', () => {
  it('posts the code with the stored verifier, clears the verifier and returns to Models', async () => {
    sessionStorage.setItem(VERIFIER_KEY, 'v'.repeat(43));
    sessionStorage.setItem(ACCOUNT_KEY, 'account-a');
    await mount(<OpenRouterCallback search="?code=code-ok" />);
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Connecting OpenRouter');
    await settle();
    expect(store.connectModelKey).toHaveBeenCalledTimes(1);
    expect(store.connectModelKey).toHaveBeenCalledWith({ method: 'pkce', code: 'code-ok', codeVerifier: 'v'.repeat(43) });
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
    expect(store.setActiveSheet).toHaveBeenCalledWith('models');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('exchanges a code once even when React mounts the page twice', async () => {
    sessionStorage.setItem(VERIFIER_KEY, 'w'.repeat(43));
    sessionStorage.setItem(ACCOUNT_KEY, 'account-a');
    await mount(<React.StrictMode><OpenRouterCallback search="?code=code-strict" /></React.StrictMode>);
    await settle();
    expect(store.connectModelKey).toHaveBeenCalledTimes(1);
    expect(store.setActiveSheet).toHaveBeenCalledWith('models');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a missing verifier is a clear error and nothing is posted', async () => {
    await mount(<OpenRouterCallback search="?code=code-no-verifier" />);
    await settle();
    expect(store.connectModelKey).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('already used');
    expect(store.setActiveSheet).not.toHaveBeenCalled();
    await click(button('Back to Models'));
    expect(store.setActiveSheet).toHaveBeenCalledWith('models');
  });

  it('a callback without a code is an error and discards the pending verifier', async () => {
    sessionStorage.setItem(VERIFIER_KEY, 'x'.repeat(43));
    sessionStorage.setItem(ACCOUNT_KEY, 'account-a');
    await mount(<OpenRouterCallback search="?error=access_denied" />);
    await settle();
    expect(store.connectModelKey).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('did not return a sign-in code');
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
  });

  it('a code OpenRouter refuses (replayed) shows the server message and does not leave the page', async () => {
    sessionStorage.setItem(VERIFIER_KEY, 'y'.repeat(43));
    sessionStorage.setItem(ACCOUNT_KEY, 'account-a');
    store.connectModelKey = vi.fn().mockRejectedValue(new Error('OpenRouter did not accept this sign-in. The code may have expired or been used already; connect again.'));
    await mount(<OpenRouterCallback search="?code=code-replayed" />);
    await settle();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('used already');
    expect(store.setActiveSheet).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
  });
});

describe('catalogue formatting', () => {
  it('formats context windows, prices and credit', () => {
    expect([formatContext(8192), formatContext(128000), formatContext(1000000), formatContext(1048576), formatContext(512)]).toEqual(['8K', '128K', '1M', '1.05M', '512']);
    expect(formatPrice({ prompt: '0.000003', completion: '0.000015' })).toBe('$3 in · $15 out per 1M');
    expect(formatPrice({ prompt: '0.00000025', completion: '0.00000125' })).toBe('$0.25 in · $1.3 out per 1M');
    expect(formatPrice({ prompt: '0', completion: '0' })).toBe('Free');
    expect(formatPrice({ prompt: '-1', completion: '-1' })).toBe('Variable price');
    expect(formatCredit({ limit: 25, limitRemaining: 19.5 })).toBe('$19.50 of $25.00 left');
    expect(formatCredit({ limit: null, limitRemaining: null })).toBe('No limit on this key');
    expect(formatCredit({})).toBeNull();
  });
});
