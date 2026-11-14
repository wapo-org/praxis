import React from 'react';
import { ClerkProvider, useClerk, useSignIn, useSignUp, useAuth, AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import type { AuthClient, AuthStep } from './client';

export function ClerkRoot({ children }: { children: (client: AuthClient, ready: boolean, signedIn: boolean) => React.ReactNode }) {
  return <ClerkProvider publishableKey={String(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)}><Bridge>{children}</Bridge></ClerkProvider>;
}
function Bridge({ children }: { children: (client: AuthClient, ready: boolean, signedIn: boolean) => React.ReactNode }) {
  const clerk = useClerk();
  const login = useSignIn();
  const register = useSignUp();
  const auth = useAuth();
  const mode = React.useRef('login');
  const finish = async (result: { status: string | null; createdSessionId: string | null }): Promise<AuthStep> => {
    if (result.status === 'complete' && result.createdSessionId) { await clerk.setActive({ session: result.createdSessionId }); return 'complete'; }
    if (result.status === 'needs_new_password') return 'password';
    if (result.status === 'needs_second_factor') throw Error('Additional authentication is required. Use an enabled email-code sign-in method.');
    return 'code';
  };
  const client: AuthClient = {
    async start(next, email, password) {
      mode.current = next;
      if (!login.signIn || !register.signUp) throw Error('Authentication is still loading');
      if (next === 'register') {
        const result = await register.signUp.create({ emailAddress: email, password });
        if (result.status === 'complete') return finish(result);
        await register.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        return 'code';
      }
      if (next === 'reset') { await login.signIn.create({ strategy: 'reset_password_email_code', identifier: email }); return 'code'; }
      if (next === 'email') {
        const result = await login.signIn.create({ identifier: email });
        const factor = result.supportedFirstFactors?.find(f => f.strategy === 'email_code');
        if (!factor || factor.strategy !== 'email_code') throw Error('Email code sign-in is not enabled');
        await login.signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
        return 'code';
      }
      return finish(await login.signIn.create({ identifier: email, password }));
    },
    async verify(code, password) {
      if (!login.signIn || !register.signUp) throw Error('Authentication is still loading');
      if (mode.current === 'register') return finish(await register.signUp.attemptEmailAddressVerification({ code }));
      if (mode.current === 'reset') {
        if (login.signIn.status === 'needs_new_password') return finish(await login.signIn.resetPassword({ password }));
        return finish(await login.signIn.attemptFirstFactor({ strategy: 'reset_password_email_code', code, password }));
      }
      return finish(await login.signIn.attemptFirstFactor({ strategy: 'email_code', code }));
    },
    async oauth(provider) {
      const flow = mode.current === 'register' ? register.signUp : login.signIn;
      if (!flow) throw Error('Authentication is still loading');
      await flow.authenticateWithRedirect({ strategy: provider === 'google' ? 'oauth_google' : 'oauth_apple', redirectUrl: '/auth/callback', redirectUrlComplete: '/' });
    },
    token: () => auth.getToken(),
    signOut: () => clerk.signOut(),
  };
  if (window.location.pathname === '/auth/callback') return <AuthenticateWithRedirectCallback />;
  return children(client, Boolean(auth.isLoaded && login.isLoaded && register.isLoaded), Boolean(auth.isSignedIn));
}
