import React from 'react';
import { useLocation } from 'react-router-dom';
import { useConvexAuth, useQuery } from 'convex/react';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { api } from '../../../../../convex/_generated/api';
import { AccountContext } from '../../lib/account';
import { apiClient } from '../../lib/api';
import { useAccountSession } from '../../lib/useAccountSession';
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
  const deletion = useQuery(api.account.deletionOwner, isAuthenticated && user === null ? {} : 'skip');
  const { readyUser, identity, signOutSession, deleteAccount, deleting, deletionError } =
    useAccountSession(user, token, emailLanding, signOut);
  const code = new URLSearchParams(location.search).get('code') ?? '';
  if (location.pathname === AUTH_ROUTES.validate) return <ValidateEmail code={code} />;
  if (location.pathname === AUTH_ROUTES.recovery) return <ResetPassword code={code} />;
  if (deleting && !user) return <AuthFrame>Deleting your account…</AuthFrame>;
  if (isLoading) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  if (!isAuthenticated) return <EmailScreens />;
  if (user === null) return <AuthFrame>
    <p role="alert">{deletionError || (deletion?.pending ? 'Account deletion is pending.' : 'This account is unavailable.')}</p>
    {deletion?.pending && <p>Deletion will continue if you sign out.</p>}
    {deletion?.pending && <button onClick={() => void deleteAccount('').catch(() => {})}>Retry account deletion</button>}
    <button onClick={() => void signOutSession()}>Sign out</button>
  </AuthFrame>;
  if (!user || !hasToken || readyUser !== user) return <AuthFrame>{AUTH_COPY.loading}</AuthFrame>;
  return <AccountContext.Provider key={user} value={{
    userId: user, displayName: identity?.name || identity?.email || user, email: identity?.email, signOut: signOutSession,
    deleteAccount,
    busy: deleting, error: '', server: apiClient.getBaseUrl() || window.location.origin,
  }}>{children}</AccountContext.Provider>;
}
