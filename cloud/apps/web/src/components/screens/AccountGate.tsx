import React from 'react';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { clearReplica, loadReplica, setReplicaIdentity, wipeReplicaStorage } from '../../lib/idb';

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
  if (checking) return <main className="account-screen">Checking session…</main>;
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
    <main className="account-screen">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(false);
        }}
      >
        <h1>Account</h1>
        <p>Sign in to your Praxis server</p>
        <label>
          Server
          <input readOnly value={apiClient.getBaseUrl() || window.location.origin} />
        </label>
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
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {notice && (
          <p role="status" data-testid="account-notice">
            {notice}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button disabled={busy}>Sign in</button>
        {import.meta.env.DEV && local && (
          <button type="button" disabled={busy} onClick={() => void signIn(true)}>
            Continue as local dev user
          </button>
        )}
      </form>
    </main>
  );
}
