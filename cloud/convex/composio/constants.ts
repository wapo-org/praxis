export const TENANT_ID_SECRET_ENV = 'PRAXIS_TENANT_ID_SECRET';
export const ALLOWED_ORIGINS_ENV = 'PRAXIS_WEB_ORIGINS';
export const NATIVE_RETURN_URL = 'praxis-app://oauth/callback';

export const COMPOSIO_ERRORS = {
  tenantSecretMissing: `${TENANT_ID_SECRET_ENV} is not configured`,
  invalidReturnUrl: 'OAuth return URL is not allowed',
  alreadyConnected: 'Toolkit is already connected',
  connectionChanged: 'Connection changed during setup',
  accountUnavailable: 'Account unavailable',
} as const;
