import { ConvexError } from 'convex/values';
import { AUTH_EMAIL_METHOD_CONFLICT } from '@praxis/protocol';
export { AUTH_PATHS as AUTH_ROUTES } from '@praxis/protocol';
export const AUTH_COPY = {
  loading: 'Checking session…',
  unavailable: 'Sign in is temporarily unavailable. Please try again later.',
  checkEmail: 'Check your email. Open the link in this browser to continue.',
  restart: 'Back to sign in',
  unknown: 'Sign in failed. Please try again.',
};
const METHOD_CONFLICT_MESSAGE = 'This email already has an account. Use its original sign-in method.';
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL: 'Enter a valid email address.',
  EMAIL_TAKEN: METHOD_CONFLICT_MESSAGE,
  USER_NOT_FOUND: 'Verify your email first, or create an account.',
  EMAIL_NOT_FOUND: 'No verified email was found. Verify your email or create an account.',
  INVALID_CREDENTIALS: 'The email or password is incorrect.',
  PASSWORD_TOO_SHORT: 'Use a longer password.',
  PASSWORD_TOO_LONG: 'Use a shorter password.',
  PASSWORD_HAS_SURROUNDING_WHITESPACE: 'Remove spaces before and after your password.',
  PASSWORD_TOO_COMMON: 'Choose a less common password.',
  MISSING_SECRET: 'Open this link in the browser that requested it, or start again.',
  INVALID_CHALLENGE: 'This link expired or has already been used. Start again.',
  INCORRECT_CODE: 'This link is invalid. Start again.',
  NOT_LOGGED_IN: 'Sign in again to continue.',
  WRONG_USER: 'Sign in to the account that requested this link.',
  OTHER_ERROR: AUTH_COPY.unknown,
  ACCESS_DENIED: 'Sign in was cancelled or denied. Try again.',
  EXPIRED: 'The sign-in request expired. Start again.',
  INVALID_FLOW: 'This browser has no matching sign-in request. Start again.',
  INVALID_STATE: 'The sign-in request expired. Start again.',
  INVALID_CODE: 'The sign-in link expired. Start again.',
};
export function authError(error: { error: string; retryAfterMs?: number; minimumLength?: number; maximumLength?: number; cause?: unknown }) {
  if (error.cause instanceof ConvexError && error.cause.data === AUTH_EMAIL_METHOD_CONFLICT) return METHOD_CONFLICT_MESSAGE;
  if (error.error === 'RATE_LIMITED') return `Too many attempts. Try again in ${Math.ceil((error.retryAfterMs ?? 0) / 1000)} seconds.`;
  if (error.error === 'PASSWORD_TOO_SHORT' && error.minimumLength) return `Use at least ${error.minimumLength} characters.`;
  if (error.error === 'PASSWORD_TOO_LONG' && error.maximumLength) return `Use at most ${error.maximumLength} characters.`;
  return MESSAGES[error.error] ?? AUTH_COPY.unknown;
}
