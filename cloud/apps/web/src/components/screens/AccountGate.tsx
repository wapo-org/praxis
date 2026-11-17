import React from 'react';
import { useLocation } from 'react-router-dom';
import { useConvexAuth, useQuery } from 'convex/react';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { api } from '../../../../../convex/_generated/api';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { clearReplica, loadReplica, setReplicaIdentity } from '../../lib/idb';
import { AuthFrame, EmailScreens, ValidateEmail, ResetPassword } from '../../auth/EmailScreens';
import { AUTH_COPY, AUTH_ROUTES } from '../../auth/constants';

export function AccountGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const emailLanding = location.pathname === AUTH_ROUTES.validate || location.pathname === AUTH_ROUTES.recovery;
  const { isAuthenticated, isLoading } = useConvexAuth();
  const user = useQuery(api.auth.currentUser, isAuthenticated ? {} : 'skip');
  const token = useAuthToken();
  const hasToken = token !== null;
  const { signOut } = useAuthActions();
  const [readyUser, setReadyUser] = React.useState<string | null>(null);
  const signOutSession = React.useCallback(async () => {
    apiClient.setSessionIdentity(null);
    apiClient.setBearerToken('');
    setReadyUser(null);
    await signOut();
    await clearReplica();
  }, [signOut]);
  React.useEffect(() => {
    apiClient.setBearerToken(token ?? '');
    apiClient.onUnauthorized = () => { void signOutSession(); };
    return () => {
      apiClient.setBearerToken('');
      apiClient.onUnauthorized = undefined;
    };
  }, [token, signOutSession]);
  React.useEffect(() => {
    let active = true;
    setReadyUser(null);
    apiClient.setSessionIdentity(user && hasToken && !emailLanding ? user : null);
    if (!user || !hasToken || emailLanding) { void clearReplica(); return; }
    void setReplicaIdentity(apiClient.getBaseUrl(), user).then(loadReplica).then(() => {
      if (active) setReadyUser(user);
    });
    return () => { active = false; apiClient.setSessionIdentity(null); };
  }, [user, hasToken, emailLanding]);
  const code = new URLSearchParams(location.search).get('code') ?? '';
  if (location.pathname === AUTH_ROUTES.validate) return <ValidateEmail code={code} />;
  if (location.pathname === AUTH_ROUTES.recovery) return <ResetPassword code={code} />;
  if (isLoading) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  if (!isAuthenticated) return <EmailScreens />;
  if (user === null) return <AuthFrame>
    <p role="alert">This account is unavailable.</p>
    <button onClick={() => void signOutSession()}>Sign out</button>
  </AuthFrame>;
  if (!user || !hasToken || readyUser !== user) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  return <AccountContext.Provider key={user} value={{
    userId: user, signOut: signOutSession,
    deleteAccount: async () => { throw new Error(AUTH_COPY.deleteUnavailable); },
    busy: false, error: '', server: apiClient.getBaseUrl() || window.location.origin,
  }}>{children}</AccountContext.Provider>;
}
