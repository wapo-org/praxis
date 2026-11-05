import React from 'react';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { ChevronRight } from '../../lib/icons';
import { clearReplica, loadReplica, setReplicaIdentity, wipeReplicaStorage } from '../../lib/idb';
import styles from './AccountGate.module.css';

export function canUseLocalDev(isDev: boolean, mode: string) {
  return isDev && mode === 'local';
}

export function AccountGate({ children }: { children: React.ReactNode }) {
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
    void apiClient
      .request<{ user: { id: string } }>('/v1/auth/session')
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
    };
  }, []);
  async function signIn(dev: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const session =
        import.meta.env.DEV && dev
          ? await import('../../lib/dev-auth').then((m) => m.devAuth())
          : await apiClient.request<{
              user: { id: string };
              bearerToken?: string;
            }>('/v1/auth/sign-in', {
              method: 'POST',
              body: JSON.stringify({ type: 'auth.input', email, password }),
            });
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
      await apiClient.request('/v1/auth/sign-out', { method: 'POST' });
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
    setPassword('');
    setNotice('Account deleted');
    setUser(null);
  }
  if (checking)
    return (
      <main className={styles.screen}>
        <p className={styles.message} role="status">
          Checking session…
        </p>
      </main>
    );
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
    <main className={styles.screen}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(false);
        }}
      >
        <div className={styles.intro}>
          <h1 className={styles.brand}>Praxis</h1>
          <p className={styles.lede}>Sign in to continue</p>
        </div>
        <label className={styles.field}>
          Email
          <input
            className={styles.input}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Password
          <input
            className={styles.input}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {notice && (
          <p role="status" className={styles.notice} data-testid="account-notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button className={styles.button} disabled={busy}>
          Sign in
        </button>
        <details className={styles.advanced}>
          <summary>
            <span className={styles.advancedChevron}>
              <ChevronRight size={16} />
            </span>
            Advanced
          </summary>
          <label className={styles.field}>
            Server
            <input className={styles.input} readOnly value={apiClient.getBaseUrl() || window.location.origin} />
          </label>
        </details>
        {import.meta.env.DEV && local && (
          <div className={styles.dev}>
            <button
              type="button"
              className={styles.button}
              data-tone="secondary"
              disabled={busy}
              onClick={() => void signIn(true)}
            >
              Continue as local dev user
            </button>
            <p className={styles.devNote}>Only on a local development server.</p>
          </div>
        )}
      </form>
    </main>
  );
}
