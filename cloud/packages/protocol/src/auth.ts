export const AUTH_PATHS = {
  home: '/',
  validate: '/validate-email',
  recovery: '/reset-password',
  changeEmail: '/confirm-email-change',
  google: '/oauth/google',
} as const;

export const AUTH_EMAIL_METHOD_CONFLICT = 'AUTH_EMAIL_METHOD_CONFLICT';

/** `ConvexError` data thrown by the owner-scoped Convex wrappers; callers branch on `code`. */
export const OWNER_ERRORS = {
  unauthenticated: { code: 'unauthenticated', message: 'Authentication required' },
  accountUnavailable: { code: 'account_unavailable', message: 'Account unavailable' },
} as const;
export type OwnerErrorCode = (typeof OWNER_ERRORS)[keyof typeof OWNER_ERRORS]['code'];
