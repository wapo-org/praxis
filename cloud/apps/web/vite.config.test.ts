import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['preview', ['apple', 'google']],
  ['production', []],
  ['development', []],
])('selects the OAuth simulator at build time for %s', async (environment, expected) => {
  vi.stubEnv('VERCEL_ENV', String(environment));
  vi.stubEnv('PRAXIS_PREVIEW_MOCK_OAUTH', 'apple, google');
  vi.resetModules();
  const { default: config } = await import('./vite.config');
  expect(config.define?.['import.meta.env.PRAXIS_MOCK_OAUTH']).toBe(JSON.stringify(expected));
});
