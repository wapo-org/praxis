export type AuthStep = 'complete' | 'code' | 'password';
export interface AuthClient {
  start(mode: 'login' | 'register' | 'reset' | 'email', email: string, password: string): Promise<AuthStep>;
  verify(code: string, password: string): Promise<AuthStep>;
  oauth(provider: 'google' | 'apple'): Promise<void>;
  token(): Promise<string | null>;
  signOut(): Promise<void>;
}
/** Deterministic local-only driver. No Clerk script, keys, email, or provider network calls. */
export function fakeClerk(): AuthClient {
  let step: AuthStep = 'code';
  return {
    async start(mode) { step = mode === 'login' ? 'complete' : 'code'; return step; },
    async verify(code) { if (code !== '123456') throw Error('Use the local test code 123456'); return 'complete'; },
    async oauth() { throw Error('OAuth requires a configured Clerk instance'); },
    async token() { return 'dev-local'; },
    async signOut() {},
  };
}
