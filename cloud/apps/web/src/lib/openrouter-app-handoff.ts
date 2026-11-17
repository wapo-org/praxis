import { OPENROUTER_APP_CALLBACK_PATH, OPENROUTER_APP_REDIRECT, OpenRouterAuthCodeSchema, type OpenRouterAppHandoffError } from '@praxis/protocol';

/** The app URL for a callback query: the code when it parses under the shared schema, otherwise an error the app shows. */
export function appHandoffUrl(search: string): string {
  const params = new URLSearchParams(search);
  const target = new URL(OPENROUTER_APP_REDIRECT);
  const code = OpenRouterAuthCodeSchema.safeParse(params.get('code'));
  if (code.success) {
    target.searchParams.set('code', code.data);
  } else {
    const error: OpenRouterAppHandoffError = params.has('code') ? 'invalid_code' : 'missing_code';
    target.searchParams.set('error', error);
  }
  return target.toString();
}

/** Runs before the app boots: this page needs no session, never sees a verifier, and never exchanges the code itself. */
export function handOffToAppIfCallback(location: Pick<Location, 'pathname' | 'search' | 'replace'>): boolean {
  if (location.pathname !== OPENROUTER_APP_CALLBACK_PATH) return false;
  location.replace(appHandoffUrl(location.search));
  return true;
}
