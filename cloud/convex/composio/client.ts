import type { TenantId } from '@praxis/types';
import { COMPOSIO_ERRORS } from './constants.js';

export interface ComposioClient {
  createConnectLink(input: {tenantId: TenantId; toolkit: string; callbackUrl: string}): Promise<{
    redirectUrl: string;
    connectedAccountId: string;
    expiresAt: number;
  }>;
  revokeConnection(connectedAccountId: string): Promise<void>;
}

export function composioFor(_env: Record<string, string | undefined>): ComposioClient {
  throw new Error(COMPOSIO_ERRORS.apiKeyMissing);
}
