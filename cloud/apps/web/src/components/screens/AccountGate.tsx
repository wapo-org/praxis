import React from 'react';
import { useConvexAuth, useQuery } from 'convex/react';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { api } from '../../../../../convex/_generated/api';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { clearReplica, loadReplica, setReplicaIdentity } from '../../lib/idb';
import { AuthFrame, EmailScreens, ValidateEmail, ResetPassword } from '../../auth/EmailScreens';
import { AUTH_COPY, AUTH_ROUTES } from '../../auth/constants';

export function AccountGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const user = useQuery(api.auth.currentUser, isAuthenticated ? {} : 'skip');
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  const [readyUser, setReadyUser] = React.useState<string | null>(null);
  React.useEffect(() => {
    apiClient.setBearerToken(token ?? '');
    return () => apiClient.setBearerToken('');
  }, [token]);
  React.useEffect(() => {
    let active = true;
    setReadyUser(null);
    if (!user) { void clearReplica(); return; }
    void setReplicaIdentity(apiClient.getBaseUrl(), user).then(loadReplica).then(() => {
      if (active) setReadyUser(user);
    });
    return () => { active = false; };
  }, [user]);
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  if (!isAuthenticated && window.location.pathname === AUTH_ROUTES.validate) return <ValidateEmail code={code} />;
  if (!isAuthenticated && window.location.pathname === AUTH_ROUTES.recovery) return <ResetPassword code={code} />;
  if (isLoading) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  if (!isAuthenticated) return <EmailScreens />;
  if (!user || readyUser !== user) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  return <AccountContext.Provider key={user} value={{
    userId: user, signOut: async () => { await signOut(); await clearReplica(); },
    deleteAccount: async () => { throw new Error(AUTH_COPY.deleteUnavailable); },
    busy: false, error: '', server: apiClient.getBaseUrl() || window.location.origin,
  }}>{children}</AccountContext.Provider>;
}
