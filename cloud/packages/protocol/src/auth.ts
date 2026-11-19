export const AUTH_PATHS = {
  home: '/',
  validate: '/validate-email',
  recovery: '/reset-password',
  changeEmail: '/confirm-email-change',
  google: '/oauth/google',
} as const;

export const AUTH_EMAIL_METHOD_CONFLICT = 'AUTH_EMAIL_METHOD_CONFLICT';
