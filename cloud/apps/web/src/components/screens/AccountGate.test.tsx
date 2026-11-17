// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api';
import { AccountGate } from './AccountGate';

const hooks = vi.hoisted(() => ({
  user: 'verified-user' as string | null,
  token: 'test-token' as string | null,
  signup: { status: 'complete' },
  recovery: { status: 'complete', pending: false, completePasswordRecovery: vi.fn() },
  signOut: vi.fn(async () => {}),
}));
beforeEach(() => {
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
  useQuery: () => hooks.user,
}));
vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signOut: hooks.signOut }), useAuthToken: () => hooks.token,
}));
vi.mock('../../lib/idb', () => ({
  clearReplica: vi.fn(), loadReplica: vi.fn(), setReplicaIdentity: vi.fn().mockResolvedValue(undefined),
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
