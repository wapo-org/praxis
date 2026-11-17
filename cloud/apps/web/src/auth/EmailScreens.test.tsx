// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmailScreens, ResetPassword, ValidateEmail } from './EmailScreens';

const hooks = vi.hoisted(() => ({
  signedIn: false, signOut: vi.fn(async () => {}), oauth: vi.fn(), login: vi.fn(), signup: vi.fn(), recovery: vi.fn(), reset: vi.fn(),
  validateState: { status: 'error', userError: { error: 'MISSING_SECRET' } },
}));
vi.mock('convex/react', () => ({ useConvexAuth: () => ({ isAuthenticated: hooks.signedIn }) }));
vi.mock('@convex-dev/auth/react', () => ({ useAuthActions: () => ({ signOut: hooks.signOut }) }));
vi.mock('@convex-dev/auth/methods/email-password/react', () => ({
  useSignInWithEmailPassword: () => ({ signIn: hooks.login, pending: false }),
  useSignUpWithEmailPassword: () => ({ signUp: hooks.signup, pending: false }),
  useStartPasswordRecovery: () => ({ startPasswordRecovery: hooks.recovery, pending: false }),
  useCompleteSignUpWithEmailPassword: () => hooks.validateState,
  useCompletePasswordRecovery: () => ({ status: 'ready', completePasswordRecovery: hooks.reset, pending: false }),
}));
vi.mock('@convex-dev/auth/methods/google/react', () => ({
  useSignInWithGoogle: () => ({ signIn: hooks.oauth }), useOauth: () => ({ flowError: null }),
}));
vi.mock('@convex-dev/auth/methods/apple/react', () => ({
  useSignInWithApple: () => ({ signIn: hooks.oauth }),
}));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  hooks.signedIn = false;
});
it('uses v2 hooks for login, signup, and browser-bound recovery', async () => {
  hooks.login.mockResolvedValue({ status: 'error', userError: { error: 'INVALID_CREDENTIALS' } });
  hooks.signup.mockResolvedValue({ success: true });
  hooks.recovery.mockResolvedValue({ success: true });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<EmailScreens />));
  async function submit() {
    await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  }
  await submit();
  expect(hooks.login).toHaveBeenCalled();
  expect(node.querySelector('[role=alert]')?.textContent).toContain('incorrect');
  await act(async () => [...node.querySelectorAll('nav button')].find(b => b.textContent?.includes('Create'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await submit();
  expect(hooks.signup).toHaveBeenCalled();
  expect(node.querySelector('[role=status]')?.textContent).toContain('this browser');
  await act(async () => [...node.querySelectorAll('nav button')].find(b => b.textContent?.includes('Forgot'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(node.querySelector('input[type=password]')).toBeNull();
  await submit();
  expect(hooks.recovery).toHaveBeenCalled();
  await act(async () => root.unmount());
});
it('explains wrong-browser validation and submits recovery through its ready state', async () => {
  hooks.reset.mockResolvedValue({ status: 'error', userError: { error: 'PASSWORD_TOO_SHORT', minimumLength: 10 } });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<ValidateEmail code="invalid" />));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('browser that requested');
  await act(async () => root.render(<ResetPassword code="reset" />));
  await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(hooks.reset).toHaveBeenCalledWith({ newPassword: '' });
  expect(node.querySelector('[role=alert]')?.textContent).toContain('10 characters');
  await act(async () => root.unmount());
});

it.each(['Google', 'Apple'])('re-enables sign-in and shows a resolved %s initiation error', async provider => {
  hooks.oauth.mockResolvedValue({ status: 'error', userError: { error: 'EXPIRED' } });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<EmailScreens />));
  const button = [...node.querySelectorAll('button')].find(b => b.textContent === 'Continue with ' + provider)!;
  await act(async () => button.click());
  expect(node.querySelector('[role=alert]')?.textContent).toContain('expired');
  expect([...node.querySelectorAll('button')].every(b => !b.disabled)).toBe(true);
  await act(async () => button.click());
  expect(hooks.oauth).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it('finishes the existing session before adopting a recovered session', async () => {
  hooks.signedIn = true;
  let signedOut!: () => void;
  hooks.signOut.mockImplementationOnce(() => new Promise<void>(resolve => { signedOut = resolve; }));
  hooks.reset.mockResolvedValue({ status: 'error', userError: { error: 'PASSWORD_TOO_SHORT', minimumLength: 10 } });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<ResetPassword code="reset" />));
  await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(hooks.signOut).toHaveBeenCalledOnce();
  expect(hooks.reset).not.toHaveBeenCalled();
  expect(node.querySelector('button')!.disabled).toBe(true);
  await act(async () => { signedOut(); });
  expect(hooks.reset).toHaveBeenCalledOnce();
  expect(node.querySelector('[role=alert]')?.textContent).toContain('10 characters');
  await act(async () => root.unmount());
});
