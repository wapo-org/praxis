// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountGateForm, submitLabel, type AccountGateFormProps } from './AccountGateForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const props = (over: Partial<AccountGateFormProps> = {}): AccountGateFormProps => ({
  mode: 'login', step: null, email: '', password: '', code: '', notice: '', error: '', pending: null,
  server: 'http://127.0.0.1', showDev: true,
  onEmail: vi.fn(), onPassword: vi.fn(), onCode: vi.fn(), onMode: vi.fn(), onSubmit: vi.fn(), onOAuth: vi.fn(), onDev: vi.fn(),
  ...over,
});
const render = (p: AccountGateFormProps) => act(() => root.render(<AccountGateForm {...p} />));
const buttons = () => [...container.querySelectorAll('button')];
const button = (text: string) => buttons().find(b => b.textContent?.includes(text))!;
const link = (text: string) => [...container.querySelectorAll('a')].find(a => a.textContent === text)!;

it('labels the primary action per screen and step', () => {
  expect(submitLabel('login', null)).toBe('Sign in');
  expect(submitLabel('register', null)).toBe('Create account');
  expect(submitLabel('register', 'code')).toBe('Verify and continue');
  expect(submitLabel('reset', null)).toBe('Reset password');
  expect(submitLabel('email', null)).toBe('Send code');
});

it('keeps secondary navigation as links and the primary first, then OAuth with logos', () => {
  const p = props();
  render(p);
  expect(buttons().map(b => b.textContent)).toEqual(['Sign in', 'Continue with Google', 'Continue with Apple', 'Continue as local dev user']);
  for (const text of ['Forgot password?', 'Sign in with an email code', 'Create one']) expect(link(text)).toBeTruthy();
  expect(button('Google').querySelector('[data-logo="google"]')).not.toBeNull();
  expect(button('Apple').querySelector('[data-logo="apple"]')).not.toBeNull();
  // Forgot password sits on the password label row.
  expect(link('Forgot password?').parentElement?.querySelector('label')?.textContent).toBe('Password');
  act(() => link('Create one').click());
  expect(p.onMode).toHaveBeenCalledWith('register');
  act(() => link('Forgot password?').click());
  expect(p.onMode).toHaveBeenCalledWith('reset');
});

it('register: footer switches back, no forgot-password link, code step adds the field', () => {
  render(props({ mode: 'register' }));
  expect(container.textContent).toContain('Already have an account?');
  expect(link('Sign in')).toBeTruthy();
  expect(link('Forgot password?')).toBeUndefined();
  render(props({ mode: 'register', step: 'code' }));
  expect(container.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull();
  expect(button('Verify and continue')).toBeTruthy();
});

it('hides the dev button outside dev and keeps its test id under a "Dev only" label', () => {
  render(props({ showDev: false }));
  expect(container.querySelector('[data-testid="local-dev-sign-in"]')).toBeNull();
  expect(container.textContent).not.toContain('Dev only');
  render(props({ showDev: true }));
  expect(container.querySelector('[data-testid="local-dev-sign-in"]')?.textContent).toBe('Continue as local dev user');
  expect(container.textContent).toContain('Dev only');
});

it('spins only the pressed button and disables the rest without changing their names', () => {
  render(props({ pending: 'google' }));
  const google = button('Google');
  expect(google.getAttribute('aria-busy')).toBe('true');
  expect(google.querySelector('.rt-Spinner')).not.toBeNull();
  for (const b of buttons()) expect(b.disabled).toBe(true);
  for (const b of buttons().filter(b => b !== google)) {
    expect(b.querySelector('.rt-Spinner')).toBeNull();
    expect(b.hasAttribute('aria-busy')).toBe(false);
  }
  expect(link('Create one').getAttribute('aria-disabled')).toBe('true');
});
