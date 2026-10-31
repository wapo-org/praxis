import { apiClient, type PraxisApiClient } from './api';
// Imported only by Vite DEV paths and development checks.
export async function devAuth(userId = 'local-user', client: PraxisApiClient = apiClient) {
  return client.request<{
    type: 'session';
    user: { type: 'user'; id: string; name?: string };
    bearerToken: string;
    expiresAt: string;
  }>('/v1/auth/dev', {
    method: 'POST',
    body: JSON.stringify({ type: 'auth.dev', userId }),
  });
}
