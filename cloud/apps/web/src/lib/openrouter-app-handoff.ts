/** iOS PKCE (PRA-81): OpenRouter only redirects to https, so this page forwards the code to the app that holds the verifier. */
export const OPENROUTER_APP_CALLBACK_PATH = '/settings/openrouter/app-callback';
/** Registered in PraxisChat's Info.plist; ASWebAuthenticationSession listens for this scheme. */
export const OPENROUTER_APP_REDIRECT = 'praxis-app://openrouter/callback';
/** OpenRouter codes are opaque tokens; anything else is not forwarded, so the page cannot be used to inject a URL. */
const CODE = /^[A-Za-z0-9._~-]{8,512}$/;

/** The app URL for a callback query: the code when it is well formed, otherwise an error the app shows. */
export function appHandoffUrl(search: string): string {
  const params = new URLSearchParams(search);
  const target = new URL(OPENROUTER_APP_REDIRECT);
  const code = params.get('code');
  if (code && CODE.test(code)) target.searchParams.set('code', code);
  else target.searchParams.set('error', params.has('code') ? 'invalid_code' : 'missing_code');
  return target.toString();
}

/** Runs before the app boots: this page needs no session, never sees a verifier, and never exchanges the code itself. */
export function handOffToAppIfCallback(location: Pick<Location, 'pathname' | 'search' | 'replace'>): boolean {
  if (location.pathname !== OPENROUTER_APP_CALLBACK_PATH) return false;
  location.replace(appHandoffUrl(location.search));
  return true;
}
