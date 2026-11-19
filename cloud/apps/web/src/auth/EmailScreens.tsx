import React from 'react';
import { Navigate } from 'react-router-dom';
import { useConvexAuth } from 'convex/react';
import { useAuthActions } from '@convex-dev/auth/react';
import { GlassChip } from '@praxis/glass';
import {
  useCompleteSignUpWithEmailPassword, useCompletePasswordRecovery,
  useSignInWithEmailPassword, useSignUpWithEmailPassword, useStartPasswordRecovery,
} from '@convex-dev/auth/methods/email-password/react';
import { useSignInWithGoogle, useOauth } from '@convex-dev/auth/methods/google/react';
import { api } from '../../../../convex/_generated/api';
import { AUTH_COPY, AUTH_ROUTES, authError } from './constants';
import authStyles from './AuthScreens.module.css';
import styles from '../components/screens/AccountGate.module.css';

type Mode = 'login' | 'register' | 'reset';
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return <main className={styles.screen}><section className={styles.form}><h1>Praxis</h1>{children}</section></main>;
}
export function EmailScreens() {
  const [mode, setMode] = React.useState<Mode>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [oauthPending, setOauthPending] = React.useState(false);
  const login = useSignInWithEmailPassword(api.auth);
  const register = useSignUpWithEmailPassword(api.auth);
  const recovery = useStartPasswordRecovery(api.auth);
  const google = useSignInWithGoogle(api.auth);
  const { flowError } = useOauth();
  const busy = login.pending || register.pending || recovery.pending || oauthPending;
  async function submit() {
    setError('');
    setMessage('');
    try {
      const result = mode === 'login' ? await login.signIn({ email, password })
        : mode === 'register' ? await register.signUp({ email, password })
        : await recovery.startPasswordRecovery({ email });
      if ('userError' in result) setError(authError(result.userError, AUTH_COPY.unavailable));
      else if (mode !== 'login') setMessage(AUTH_COPY.checkEmail);
    } catch {
      setError(AUTH_COPY.unavailable);
    }
  }
  async function signInWithGoogle() {
    if (import.meta.env.PRAXIS_MOCK_OAUTH?.includes('google')) {
      setMessage('');
      setError('This preview simulates an unavailable Google sign-in. Use email to continue.');
      return;
    }
    setOauthPending(true);
    setError('');
    try {
      const result = await google.signIn({ redirectTo: window.location.origin + AUTH_ROUTES.home });
      if (result.status === 'error') {
        setError(authError(result.userError));
        setOauthPending(false);
      }
    } catch {
      setError(AUTH_COPY.unknown);
      setOauthPending(false);
    }
  }
  const label = mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send recovery link';
  return <AuthFrame>
    <form className={styles.fields} onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className={styles.field}>Email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      {mode !== 'reset' && <label className={styles.field}>Password<input type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
      <GlassChip type="submit" className={`${styles.action} ${authStyles.button}`} disabled={busy}>{label}</GlassChip>
    </form>
    {message && <p role="status">{message}</p>}
    {(error || flowError) && <p role="alert">{error || (flowError && authError(flowError))}</p>}
    {mode !== 'reset' && <div className={styles.oauthGroup}>
      <GlassChip className={`${styles.action} ${authStyles.button}`} disabled={busy} onClick={() => void signInWithGoogle()}>
        Continue with Google
      </GlassChip>
    </div>}
    <nav className={authStyles.actions}>{(['login', 'register', 'reset'] as const).filter(next => next !== mode).map(next =>
      <button key={next} disabled={busy} onClick={() => { setMode(next); setMessage(''); setError(''); setPassword(''); }}>{next === 'login' ? 'Sign in' : next === 'register' ? 'Create account / resend verification' : 'Forgot password?'}</button>)}</nav>
  </AuthFrame>;
}
function LinkStatus({ state }: { state: { status: 'loading' } | { status: 'error'; userError: { error: string } } }) {
  return <>{state.status === 'error' ? <p role="alert">{authError(state.userError)}</p> : <p role="status">{AUTH_COPY.loading}</p>}
    <a href={AUTH_ROUTES.home}>{AUTH_COPY.restart}</a></>;
}
export function ValidateEmail({ code }: { code: string }) {
  const state = useCompleteSignUpWithEmailPassword(api.auth, { emailCode: code });
  if (state.status === 'complete') return <Navigate to={AUTH_ROUTES.home} replace />;
  return <AuthFrame><LinkStatus state={state} /></AuthFrame>;
}
export function ResetPassword({ code }: { code: string }) {
  const { isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const [submitting, setSubmitting] = React.useState(false);
  const state = useCompletePasswordRecovery(api.auth, { emailCode: code });
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  if (state.status === 'complete') return <Navigate to={AUTH_ROUTES.home} replace />;
  if (state.status !== 'ready') return <AuthFrame><LinkStatus state={state} /></AuthFrame>;
  async function complete() {
    if (state.status !== 'ready') return;
    setSubmitting(true);
    setError('');
    try {
      // Recovery replaces credentials; finish the current session before the hook adopts the recovered session.
      if (isAuthenticated) await signOut();
      const result = await state.completePasswordRecovery({ newPassword: password });
      if ('userError' in result) setError(authError(result.userError));
    } catch {
      setError(AUTH_COPY.unknown);
    } finally {
      setSubmitting(false);
    }
  }
  return <AuthFrame><form onSubmit={e => {
    e.preventDefault();
    void complete();
  }}>
    <label className={styles.field}>New password<input type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    <GlassChip type="submit" className={authStyles.button} disabled={state.pending || submitting}>Change password</GlassChip>
    {error && <p role="alert">{error}</p>}
  </form></AuthFrame>;
}
