// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api';
import { useAccount } from '../../lib/account';
import { clearReplica } from '../../lib/idb';
import { AccountGate } from './AccountGate';

const hooks = vi.hoisted(() => ({
  pending: false,
  user: 'verified-user' as string | null,
  token: 'test-token' as string | null,
  signup: { status: 'complete' },
  recovery: { status: 'complete', pending: false, completePasswordRecovery: vi.fn() },
  signOut: vi.fn(async () => {}),
}));
beforeEach(() => {
  hooks.pending = false;
  hooks.token = 'test-token';
  hooks.user = 'verified-user';
  hooks.signup.status = 'complete';
  hooks.recovery.status = 'complete';
});
vi.mock('@convex-dev/auth/methods/email-password/react', () => ({
  useCompleteSignUpWithEmailPassword: () => hooks.signup,
  useCompletePasswordRecovery: () => hooks.recovery,
}));
vi.mock('convex/react', () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (reference: FunctionReference<'query'>, args: unknown) => {
    if (args === 'skip') return undefined;
    return getFunctionName(reference) === 'account:deletionOwner'
      ? (hooks.pending ? { userId: 'verified-user', pending: true } : null)
      : hooks.user;
  },
}));
vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signOut: hooks.signOut }), useAuthToken: () => hooks.token,
}));
vi.mock('../../lib/idb', () => ({
  clearReplica: vi.fn(), loadReplica: vi.fn(), replicaIdentityMatches: vi.fn(() => true), setReplicaIdentity: vi.fn().mockResolvedValue(undefined),
}));
function Location() {
  const location = useLocation();
  return <output>{location.pathname}{location.search}</output>;
}
it.each(['/validate-email', '/reset-password'])('replaces completed %s links with the home route', async path => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path + '?code=one-time-code']}>
      <AccountGate><p>Private chat</p></AccountGate><Location />
    </MemoryRouter>,
  ));
  expect(node.querySelector('output')?.textContent).toBe('/');
  expect(node.textContent).toContain('Private chat');
  expect(node.textContent).not.toContain('Page not found');
  await act(async () => root.unmount());
});

it('keeps a valid recovery form reachable in an existing session until completion', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hooks.recovery.status = 'ready';
  const node = document.createElement('div');
  const root = createRoot(node);
  const tree = () => <MemoryRouter initialEntries={['/reset-password?code=valid-link']}>
    <AccountGate><p>Private chat</p></AccountGate><Location />
  </MemoryRouter>;
  await act(async () => root.render(tree()));
  expect(node.querySelector('output')?.textContent).toBe('/reset-password?code=valid-link');
  expect(node.querySelector('input[autocomplete=new-password]')).not.toBeNull();
  expect(node.textContent).not.toContain('Private chat');
  hooks.recovery.status = 'complete';
  await act(async () => root.render(tree()));
  expect(node.querySelector('output')?.textContent).toBe('/');
  expect(node.textContent).toContain('Private chat');
  await act(async () => root.unmount());
});

it('closes private work when the token disappears before cached identity updates', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hooks.token = null;
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<MemoryRouter>
    <AccountGate><p>Private chat</p></AccountGate>
  </MemoryRouter>));
  expect(node.textContent).not.toContain('Private chat');
  expect(apiClient.getSessionSignal().aborted).toBe(true);
  await act(async () => root.unmount());
});

it('allows a signed-in browser to leave an unavailable account', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hooks.user = null;
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<MemoryRouter>
    <AccountGate><p>Private chat</p></AccountGate>
  </MemoryRouter>));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('account is unavailable');
  expect(node.textContent).not.toContain('Private chat');
  await act(async () => node.querySelector('button')!.click());
  expect(hooks.signOut).toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('completes an authenticated deletion even when Convex closes the private screen mid-request', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement('div');
  const root = createRoot(node);
  let respond: (response: Response) => void = () => {};
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { respond = resolve; }));
  const signOutCalls = hooks.signOut.mock.calls.length;
  vi.stubGlobal('fetch', fetcher);
  function Settings() {
    const account = useAccount();
    return <button onClick={() => void account?.deleteAccount('test-password')}>Confirm deletion</button>;
  }
  const tree = () => <MemoryRouter><AccountGate><Settings /></AccountGate></MemoryRouter>;
  try {
    await act(async () => root.render(tree()));
    await act(async () => node.querySelector('button')!.click());
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('/v1/account');
    expect(request).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({type: 'account.delete', password: 'test-password'}),
    });

    hooks.user = null;
    await act(async () => root.render(tree()));
    expect(apiClient.getSessionSignal().aborted).toBe(true);
    expect(request?.signal?.aborted).toBe(false);
    expect(node.textContent).toContain('Deleting your account');

    await act(async () => respond(Response.json({type: 'account.deleted'})));
    expect(hooks.signOut).toHaveBeenCalledTimes(signOutCalls + 1);
    expect(apiClient.getBearerToken()).toBe('');
    expect(clearReplica).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
