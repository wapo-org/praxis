import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, PraxisApiClient } from './api';
import { clearReplica, loadReplica, setReplicaIdentity } from './idb';

export function useAccountSession(
  user: string | null | undefined,
  token: string | null,
  emailLanding: boolean,
  signOut: () => Promise<void>,
) {
  const hasToken = token !== null;
  const [deleting, setDeleting] = useState(false);
  const [deletionError, setDeletionError] = useState('');
  const deletionInFlight = useRef(false);
  const [readyUser, setReadyUser] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ name: string; email?: string } | null>(null);
  const signOutSession = useCallback(async () => {
    apiClient.setSessionIdentity(null);
    apiClient.setBearerToken('');
    setReadyUser(null);
    setIdentity(null);
    try {
      await signOut();
    } finally {
      await clearReplica();
    }
  }, [signOut]);
  useEffect(() => {
    apiClient.setBearerToken(token ?? '');
    apiClient.onUnauthorized = () => {
      if (!deletionInFlight.current) void signOutSession();
    };
    return () => {
      apiClient.setBearerToken('');
      apiClient.onUnauthorized = undefined;
    };
  }, [token, signOutSession]);
  useEffect(() => {
    let active = true;
    setReadyUser(null);
    apiClient.setSessionIdentity(user && hasToken && !emailLanding ? user : null);
    if (!user || !hasToken || emailLanding) {
      void clearReplica();
      return;
    }
    void Promise.all([setReplicaIdentity(apiClient.getBaseUrl(), user).then(loadReplica), apiClient.bootstrap()]).then(([, bootstrap]) => {
      if (active) { setIdentity({ name: bootstrap.user.name, email: bootstrap.user.email }); setReadyUser(user); }
    });
    return () => { active = false; apiClient.setSessionIdentity(null); };
  }, [user, hasToken, emailLanding]);

  async function deleteAccount(password: string) {
    if (deletionInFlight.current) return;
    deletionInFlight.current = true;
    setDeleting(true);
    setDeletionError('');
    try {
      // The owner query closes the replica as soon as the server starts deletion.
      const deletionClient = new PraxisApiClient({ baseUrl: apiClient.getBaseUrl(), bearerToken: token ?? '' });
      await deletionClient.deleteAccount(password);
      await signOutSession();
    } catch (error) {
      setDeletionError(error instanceof Error ? error.message : 'Account deletion failed.');
      throw error;
    } finally {
      deletionInFlight.current = false;
      setDeleting(false);
    }
  }

  return { readyUser, identity, signOutSession, deleteAccount, deleting, deletionError };
}
