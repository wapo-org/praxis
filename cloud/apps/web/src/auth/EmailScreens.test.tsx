// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { AUTH_EMAIL_METHOD_CONFLICT } from '@praxis/protocol';
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
afterEach(() => vi.unstubAllEnvs());
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

it.each([
  ['rejected fetch', () => hooks.login.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
  ['folded fetch failure', () => hooks.login.mockResolvedValueOnce({
    status: 'error', userError: { error: 'OTHER_ERROR', cause: new TypeError('Failed to fetch') },
  })],
  ['folded HTTP failure', () => hooks.login.mockResolvedValueOnce({
    status: 'error', userError: { error: 'OTHER_ERROR', cause: new Error('Service unavailable') },
  })],
])('reports a %s and allows the email form to retry', async (_scenario, failSignIn) => {
  failSignIn();
  hooks.login.mockResolvedValueOnce({ status: 'error', userError: { error: 'INVALID_CREDENTIALS' } });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<EmailScreens />));
  const submit = () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await act(async () => { submit(); });
  expect(node.querySelector('[role=alert]')?.textContent).toBe('Sign in is temporarily unavailable. Please try again later.');
  expect([...node.querySelectorAll('input, button')].every(control => !control.hasAttribute('disabled'))).toBe(true);
  await act(async () => { submit(); });
  expect(node.querySelector('[role=alert]')?.textContent).toContain('incorrect');
  await act(async () => root.unmount());
});

it('preserves the account method conflict message for a folded Convex error', async () => {
  hooks.login.mockResolvedValueOnce({
    status: 'error', userError: { error: 'OTHER_ERROR', cause: new ConvexError(AUTH_EMAIL_METHOD_CONFLICT) },
  });
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<EmailScreens />));
  await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Use its original sign-in method.');
  await act(async () => root.unmount());
});

it.each(['Google', 'Apple'])('keeps the signed-out screen usable when Preview simulates %s', async provider => {
  vi.stubEnv('PRAXIS_MOCK_OAUTH', 'google,apple');
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(<EmailScreens />));
  const button = [...node.querySelectorAll('button')].find(item => item.textContent === 'Continue with ' + provider)!;
  await act(async () => button.click());
  expect(hooks.oauth).not.toHaveBeenCalled();
  expect(node.querySelector('[role=alert]')?.textContent).toBe(`This preview simulates an unavailable ${provider} sign-in. Use email to continue.`);
  expect(button.disabled).toBe(false);
  await act(async () => root.unmount());
});
