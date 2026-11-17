import { describe, expect, it, vi } from 'vitest';
import { appHandoffUrl, handOffToAppIfCallback, OPENROUTER_APP_CALLBACK_PATH } from './openrouter-app-handoff';

describe('OpenRouter app handoff', () => {
  it('forwards a well-formed code to the app scheme and nothing else', () => {
    expect(appHandoffUrl('?code=abcDEF123-_.~xyz')).toBe('praxis-app://openrouter/callback?code=abcDEF123-_.%7Exyz');
    expect(appHandoffUrl('?code=abc12345&state=x&redirect=https://evil.test')).toBe('praxis-app://openrouter/callback?code=abc12345');
  });

  it('turns a missing or malformed code into an error the app can show', () => {
    expect(appHandoffUrl('')).toBe('praxis-app://openrouter/callback?error=missing_code');
    expect(appHandoffUrl('?error=access_denied')).toBe('praxis-app://openrouter/callback?error=missing_code');
    for (const bad of ['short', 'has space here', 'https://evil.test/x', `${'a'.repeat(513)}`]) {
      expect(appHandoffUrl(`?code=${encodeURIComponent(bad)}`)).toBe('praxis-app://openrouter/callback?error=invalid_code');
    }
  });

  it('acts only on its own path, before the signed-in app renders', () => {
    const replace = vi.fn();
    expect(handOffToAppIfCallback({ pathname: '/settings/openrouter/callback', search: '?code=abc12345', replace })).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(handOffToAppIfCallback({ pathname: OPENROUTER_APP_CALLBACK_PATH, search: '?code=abc12345', replace })).toBe(true);
    expect(replace).toHaveBeenCalledWith('praxis-app://openrouter/callback?code=abc12345');
  });
});
