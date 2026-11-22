import { OPENROUTER_APP_CALLBACK_PATH } from '@praxis/protocol';
import { describe, expect, it, vi } from 'vitest';
import { appHandoffUrl, handOffToAppIfCallback } from './openrouter-app-handoff';

describe('OpenRouter app handoff', () => {
  it('forwards the code, URL-encoded, and drops every other parameter', () => {
    expect(appHandoffUrl('?code=abcDEF123-_.~xyz')).toBe('praxis-app://openrouter/callback?code=abcDEF123-_.%7Exyz');
    expect(appHandoffUrl('?code=abc12345&state=x&redirect=https://evil.test')).toBe('praxis-app://openrouter/callback?code=abc12345');
    expect(appHandoffUrl(`?code=${encodeURIComponent('a&error=x#y')}`)).toBe('praxis-app://openrouter/callback?code=a%26error%3Dx%23y');
  });

  it('turns a missing code or one outside the shared schema into an error the app can show', () => {
    expect(appHandoffUrl('')).toBe('praxis-app://openrouter/callback?error=missing_code');
    expect(appHandoffUrl('?error=access_denied')).toBe('praxis-app://openrouter/callback?error=missing_code');
    expect(appHandoffUrl('?code=')).toBe('praxis-app://openrouter/callback?error=invalid_code');
    expect(appHandoffUrl(`?code=${'a'.repeat(2001)}`)).toBe('praxis-app://openrouter/callback?error=invalid_code');
  });

  it('acts only on its own path, before the signed-in app renders', () => {
    const replace = vi.fn();
    expect(handOffToAppIfCallback({ pathname: '/settings/openrouter/callback', search: '?code=abc12345', replace })).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(handOffToAppIfCallback({ pathname: OPENROUTER_APP_CALLBACK_PATH, search: '?code=abc12345', replace })).toBe(true);
    expect(replace).toHaveBeenCalledWith('praxis-app://openrouter/callback?code=abc12345');
  });
});
