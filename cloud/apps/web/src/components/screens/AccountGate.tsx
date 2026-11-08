import React from 'react';
import { Button, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
const ClerkRoot = React.lazy(() => import('../../auth/ClerkBridge').then(m => ({ default: m.ClerkRoot })));
import { fakeClerk, type AuthClient, type AuthStep } from '../../auth/client';
import styles from './AccountGate.module.css';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { clearReplica, loadReplica, setReplicaIdentity, wipeReplicaStorage } from '../../lib/idb';

export function canUseLocalDev(isDev: boolean, mode: string) {
  return isDev && mode === 'local';
}

export function AccountGate({ children }: { children: React.ReactNode }) {
  if (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) return <React.Suspense fallback={<main className={styles.screen}>Loading sign in…</main>}><ClerkRoot>{(auth, ready, signedIn) => <Gate auth={auth} ready={ready} signedIn={signedIn}>{children}</Gate>}</ClerkRoot></React.Suspense>;
  return <Gate>{children}</Gate>;
}
function Gate({ children, auth, ready = true, signedIn = false }: { children: React.ReactNode; auth?: AuthClient; ready?: boolean; signedIn?: boolean }) {
  const fake = React.useMemo(() => fakeClerk(), []);
  const [mode, setMode] = React.useState<'login' | 'register' | 'reset' | 'email'>('login');
  const [step, setStep] = React.useState<AuthStep | null>(null);
  const [code, setCode] = React.useState('');
  const [user, setUser] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [local, setLocal] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const accept = async (id: string) => {
    await setReplicaIdentity(apiClient.getBaseUrl(), id);
    await loadReplica();
    setUser(id);
  };
  React.useEffect(() => {
    let active = true;
    apiClient.tokenProvider = auth ? () => auth.token() : undefined;
    apiClient.onUnauthorized = () => {
      setUser(null);
      apiClient.setBearerToken('');
      void clearReplica();
    };
    void apiClient
      .request<{ mode: string }>('/health')
      .then((h) => {
        if (active) setLocal(canUseLocalDev(import.meta.env.DEV, h.mode));
      })
      .catch(() => {});
    if (auth && (!ready || !signedIn)) { setUser(null); setChecking(false); return () => { active = false; apiClient.onUnauthorized = undefined; apiClient.tokenProvider = undefined; }; }
    void (auth ? auth.token().then(token => { apiClient.setBearerToken(token ?? ''); }) : Promise.resolve()).then(() => apiClient
      .request<{ user: { id: string } }>('/v1/auth/session'))
      .then((s) => {
        if (active) return accept(s.user.id);
      })
      .catch((e) => {
        if (active && e.status !== 401) setError(e.message);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
      apiClient.onUnauthorized = undefined;
      apiClient.tokenProvider = undefined;
    };
  }, [ready, signedIn]);
  async function signIn(dev: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let session: { user: { id: string }; bearerToken?: string };
      if (dev && import.meta.env.DEV) session = await import('../../lib/dev-auth').then(m => m.devAuth());
      else {
        const driver = auth ?? (import.meta.env.DEV && local ? fake : null);
        if (!driver) throw Error('Clerk is not configured on this server');
        const next = step ? await driver.verify(code, password) : await driver.start(mode, email, password);
        if (next !== 'complete') { setStep(next); setNotice(auth ? 'Check your email for a verification code' : 'Local test code: 123456'); return; }
        if (import.meta.env.DEV && !auth) session = await import('../../lib/dev-auth').then(m => m.devAuth());
        else if (!auth) throw Error('Clerk is not configured');
        else { apiClient.setBearerToken(await driver.token() ?? ''); session = await apiClient.request('/v1/auth/session'); session.bearerToken = apiClient.getBearerToken(); }
      }
      apiClient.setBearerToken(session.bearerToken ?? '');
      await accept(session.user.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      if (auth) await auth.signOut();
      else await apiClient.request('/v1/auth/sign-out', { method: 'POST' });
      apiClient.setBearerToken('');
      setUser(null);
      await clearReplica();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign out failed');
    } finally {
      setBusy(false);
    }
  }
  async function deleteAccount(confirmPassword: string) {
    await apiClient.request('/v1/account', {
      method: 'DELETE',
      body: JSON.stringify({
        type: 'account.delete',
        ...(confirmPassword ? { password: confirmPassword } : {}),
      }),
    });
    // The server has revoked every session; forget the credential and this device's copy of the data.
    apiClient.setBearerToken('');
    await wipeReplicaStorage();
    if (auth) await auth.signOut();
    setPassword('');
    setNotice('Account deleted');
    setUser(null);
  }
  React.useEffect(() => {
    if (!auth || !signedIn) return;
    const refresh = () => { void auth.token().then(token => apiClient.setBearerToken(token ?? '')); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [auth, signedIn]);
  if (checking || !ready) return <main className={styles.screen}>Checking session…</main>;
  if (user)
    return (
      <AccountContext.Provider
        key={user}
        value={{
          userId: user,
          signOut,
          deleteAccount,
          busy,
          error,
          server: apiClient.getBaseUrl() || window.location.origin,
        }}
      >
        {children}
      </AccountContext.Provider>
    );
  return (
    <Theme appearance={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'} radius="full" accentColor="gray">
    <main className={styles.screen}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(false);
        }}
      >
        <h1>Praxis</h1>
        <p>{mode === 'register' ? 'Create your Praxis account' : mode === 'reset' ? 'Reset your password' : 'Sign in to your Praxis server'}</p>
        <details>
          <summary>Advanced</summary>
          <label>
            Server
            <input readOnly value={apiClient.getBaseUrl() || window.location.origin} />
          </label>
        </details>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {mode !== 'email' && <label>
          {mode === 'reset' ? 'New password' : 'Password'}
          <input
            type="password"
            autoComplete={mode === 'register' || mode === 'reset' ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>}
        {step === 'code' && <label>Email code<input autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={e => setCode(e.target.value)} /></label>}
        {notice && (
          <p role="status" data-testid="account-notice">
            {notice}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <Button variant="classic" radius="full" disabled={busy} loading={busy}>{step ? 'Verify and continue' : mode === 'register' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Sign in'}</Button>
        <div id="clerk-captcha" />
        {(['google', 'apple'] as const).map(provider => <Button key={provider} variant="classic" radius="full" color="gray" type="button" disabled={busy} onClick={() => { setBusy(true); void (auth ?? fake).oauth(provider).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>Continue with {provider === 'google' ? 'Google' : 'Apple'}</Button>)}
        <Button variant="classic" radius="full" color="gray" type="button" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setStep(null); setNotice(''); setError(''); }}>{mode === 'register' ? 'Already have an account? Sign in' : mode === 'login' ? 'Create an account' : 'Back to sign in'}</Button>
        <Button variant="classic" radius="full" color="gray" type="button" disabled={busy} onClick={() => { setMode('reset'); setStep(null); }}>Forgot password?</Button>
        <Button variant="classic" radius="full" color="gray" type="button" disabled={busy} onClick={() => { setMode('email'); setStep(null); }}>Sign in with an email code</Button>
        {import.meta.env.DEV && local && (
          <Button variant="classic" radius="full" color="gray" type="button" disabled={busy} onClick={() => void signIn(true)}>
            Continue as local dev user
          </Button>
        )}
      </form>
    </main>
    </Theme>
  );
}
