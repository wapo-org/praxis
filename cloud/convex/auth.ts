import { setupConvexAuth, getAuthUserId } from '@convex-dev/auth/server';
import { setupEmailPassword } from '@convex-dev/auth/methods/email-password/server';
import { setupGoogle } from '@convex-dev/auth/methods/google/server';
import { setupApple } from '@convex-dev/auth/methods/apple/server';
import { components, internal } from './_generated/api.js';
import { env, query } from './_generated/server.js';
import { activeOwner } from './accountOwner.js';
import { AUTH_ENV, AUTH_PATHS } from './authConstants.js';

const siteUrl = new URL(env[AUTH_ENV.siteUrl]).origin;
const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;
const emailPassword = setupEmailPassword(auth, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender: {
    kind: 'resend',
    sendEmail: components.resend.lib.sendEmail,
    apiKey: env[AUTH_ENV.resendKey],
    from: `${env[AUTH_ENV.senderName]} <${env[AUTH_ENV.senderEmail]}>`,
  },
  urls: {
    signUp: siteUrl + AUTH_PATHS.validate,
    recovery: siteUrl + AUTH_PATHS.recovery,
    changeEmail: siteUrl + AUTH_PATHS.changeEmail,
  },
}).attachUserCallbacks({ createUser: internal.users.createUser, onSignIn: internal.users.onEmailSignIn });
export const {
  signUpWithEmailPassword, completeSignUpWithEmailPassword, signInWithEmailPassword,
  startPasswordRecovery, checkPasswordRecovery, completePasswordRecovery,
} = emailPassword;
export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(auth, {
  component: components.authGoogle,
  allowedRedirectOrigins: [siteUrl],
}).attachUserCallbacks({
  createUser: internal.users.createUserGoogle,
  onSignIn: internal.users.onOAuthSignInGoogle,
});
export const { startSignInWithApple, completeSignInWithApple } = setupApple(auth, {
  component: components.authApple,
  allowedRedirectOrigins: [siteUrl],
}).attachUserCallbacks({
  createUser: internal.users.createUserApple,
  onSignIn: internal.users.onOAuthSignInApple,
});
export const currentUser = query({
  args: {},
  handler: async ctx => {
    const id = await getAuthUserId(ctx);
    return id && await activeOwner(ctx, id) ? id : null;
  },
});
