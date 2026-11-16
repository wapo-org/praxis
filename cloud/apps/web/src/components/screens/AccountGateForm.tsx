import React from 'react';
import { Button, Spinner, Theme, VisuallyHidden } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import type { AuthStep } from '../../auth/client';
import { AppleLogo, GoogleLogo } from './AccountGateLogos';
import styles from './AccountGate.module.css';

export type AuthMode = 'login' | 'register' | 'reset' | 'email';
/** The control whose request is in flight: only it shows a spinner, the rest are just disabled. */
export type AuthPending = 'submit' | 'google' | 'apple' | 'dev' | null;

const SUBTITLE: Record<AuthMode, string> = {
  login: 'Sign in to your Praxis server',
  register: 'Create your Praxis account',
  reset: 'Reset your password',
  email: 'Sign in with an email code',
};

export function submitLabel(mode: AuthMode, step: AuthStep | null) {
  if (step) return 'Verify and continue';
  return mode === 'register' ? 'Create account' : mode === 'reset' ? 'Reset password' : mode === 'email' ? 'Send code' : 'Sign in';
}

function Pending({ on, children }: { on: boolean; children: React.ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <>
      <span className={styles.ghost} aria-hidden="true">{children}</span>
      <VisuallyHidden>{children}</VisuallyHidden>
      <span className={styles.spinner} aria-hidden="true"><Spinner size="2" /></span>
    </>
  );
}

export interface AccountGateFormProps {
  mode: AuthMode;
  step: AuthStep | null;
  email: string;
  password: string;
  code: string;
  notice: string;
  error: string;
  pending: AuthPending;
  server: string;
  /** Dev builds against a local API only. */
  showDev: boolean;
  onEmail(value: string): void;
  onPassword(value: string): void;
  onCode(value: string): void;
  onMode(mode: AuthMode): void;
  onSubmit(): void;
  onOAuth(provider: 'google' | 'apple'): void;
  onDev(): void;
}

export function AccountGateForm(props: AccountGateFormProps) {
  const { mode, step, pending } = props;
  const busy = pending !== null;
  const id = React.useId();
  const oauth = mode === 'login' || mode === 'register';
  // In-screen navigation, so these are links (role and look), never extra buttons.
  const link = (target: AuthMode, label: string, className?: string) => (
    <a
      href={`#${target}`}
      className={[styles.link, className].filter(Boolean).join(' ')}
      aria-disabled={busy || undefined}
      onClick={(e) => { e.preventDefault(); if (!busy) props.onMode(target); }}
    >
      {label}
    </a>
  );
  const appearance = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  return (
    <Theme appearance={appearance} radius="full" accentColor="gray" hasBackground={false}>
      <main className={styles.screen}>
        <form
          className={styles.form}
          data-mode={mode}
          onSubmit={(e) => { e.preventDefault(); if (!busy) props.onSubmit(); }}
        >
          <header className={styles.header}>
            <h1>Praxis</h1>
            <p>{SUBTITLE[mode]}</p>
          </header>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor={`${id}-email`}>Email</label>
              <input id={`${id}-email`} type="email" autoComplete="username" required value={props.email} onChange={(e) => props.onEmail(e.target.value)} />
            </div>
            {mode !== 'email' && (
              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label htmlFor={`${id}-password`}>{mode === 'reset' ? 'New password' : 'Password'}</label>
                  {mode === 'login' && link('reset', 'Forgot password?')}
                </div>
                <input
                  id={`${id}-password`}
                  type="password"
                  autoComplete={mode === 'register' || mode === 'reset' ? 'new-password' : 'current-password'}
                  required
                  value={props.password}
                  onChange={(e) => props.onPassword(e.target.value)}
                />
              </div>
            )}
            {step === 'code' && (
              <div className={styles.field}>
                <label htmlFor={`${id}-code`}>Email code</label>
                <input id={`${id}-code`} autoComplete="one-time-code" inputMode="numeric" required autoFocus value={props.code} onChange={(e) => props.onCode(e.target.value)} />
              </div>
            )}
          </div>
          {props.notice && <p role="status" data-testid="account-notice" className={styles.notice}>{props.notice}</p>}
          {props.error && <p role="alert" className={styles.error}>{props.error}</p>}
          <div className={styles.primaryGroup}>
            <Button
              variant="classic"
              radius="full"
              size="3"
              highContrast
              className={`${styles.action} ${styles.primary}`}
              data-pending={pending === 'submit' || undefined}
              disabled={busy}
              aria-busy={pending === 'submit' || undefined}
            >
              <Pending on={pending === 'submit'}>{submitLabel(mode, step)}</Pending>
            </Button>
            {mode === 'login' && link('email', 'Sign in with an email code', styles.secondaryLink)}
          </div>
          <div id="clerk-captcha" className={styles.captcha} />
          {oauth && (
            <>
              <div className={styles.divider} role="separator" aria-label="or"><span aria-hidden="true">or</span></div>
              <div className={styles.oauthGroup}>
                {(['google', 'apple'] as const).map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="classic"
                    radius="full"
                    size="3"
                    color="gray"
                    className={`${styles.action} ${styles.oauth}`}
                    data-pending={pending === provider || undefined}
                    disabled={busy}
                    aria-busy={pending === provider || undefined}
                    onClick={() => props.onOAuth(provider)}
                  >
                    <Pending on={pending === provider}>
                      {provider === 'google' ? <GoogleLogo /> : <AppleLogo />}
                      {provider === 'google' ? 'Continue with Google' : 'Continue with Apple'}
                    </Pending>
                  </Button>
                ))}
              </div>
            </>
          )}
          <p className={styles.footer}>
            {mode === 'login' ? <>No account? {link('register', 'Create one')}</>
              : mode === 'register' ? <>Already have an account? {link('login', 'Sign in')}</>
              : link('login', 'Back to sign in')}
          </p>
          <details className={styles.advanced}>
            <summary>Advanced</summary>
            <div className={styles.field}>
              <label htmlFor={`${id}-server`}>Server</label>
              <input id={`${id}-server`} readOnly value={props.server} />
            </div>
          </details>
          {props.showDev && (
            <div className={styles.dev}>
              <span className={styles.devLabel}>Dev only</span>
              <Button
                type="button"
                variant="classic"
                radius="full"
                size="2"
                color="gray"
                className={`${styles.action} ${styles.devButton}`}
                data-testid="local-dev-sign-in"
                data-pending={pending === 'dev' || undefined}
                disabled={busy}
                aria-busy={pending === 'dev' || undefined}
                onClick={props.onDev}
              >
                <Pending on={pending === 'dev'}>Continue as local dev user</Pending>
              </Button>
            </div>
          )}
        </form>
      </main>
    </Theme>
  );
}
