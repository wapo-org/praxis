/** The verifier stays in this tab's sessionStorage and is removed when read, so a code completes once. */
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_CALLBACK_PATH = '/settings/openrouter/callback';
const VERIFIER_KEY = 'praxis.openrouter.pkce-verifier';
const ACCOUNT_KEY = 'praxis.openrouter.pkce-account';

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Stores a fresh verifier and returns the OpenRouter URL to send the user to. */
export async function beginOpenRouterConnect(accountId: string, origin: string = window.location.origin): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', `${origin}${OPENROUTER_CALLBACK_PATH}`);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(ACCOUNT_KEY, accountId);
  return url.toString();
}

/** The stored verifier, removed as it is read. Null when there is none (replayed link, another tab). */
export function takeVerifier(accountId?: string): string | null {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const initiatingAccount = sessionStorage.getItem(ACCOUNT_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(ACCOUNT_KEY);
  return verifier && accountId && initiatingAccount === accountId ? verifier : null;
}
