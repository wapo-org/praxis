import { z } from 'zod';
import { ALLOWED_ORIGINS_ENV, COMPOSIO_ERRORS, NATIVE_RETURN_URL } from './constants.js';

const webReturnUrl = z.url().transform(value => new URL(value)).refine(url =>
  url.protocol === 'https:' && !url.username && !url.password
  && !url.href.includes('#') && !url.href.includes('?'),
);

export function returnTarget(raw: string, env: Record<string, string | undefined>): string {
  if (raw === NATIVE_RETURN_URL) return raw;

  const parsed = webReturnUrl.safeParse(raw);
  const origins = env[ALLOWED_ORIGINS_ENV]?.split(',').map(origin => origin.trim());
  if (!parsed.success || !origins?.includes(parsed.data.origin)) {
    throw new Error(COMPOSIO_ERRORS.invalidReturnUrl);
  }
  return parsed.data.href;
}
