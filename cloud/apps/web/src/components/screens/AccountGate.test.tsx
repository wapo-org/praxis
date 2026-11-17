// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { AccountGate } from './AccountGate';

vi.mock('convex/react', () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => 'verified-user',
}));
vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signOut: vi.fn() }), useAuthToken: () => 'test-token',
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
