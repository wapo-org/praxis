import type { APIRequestContext, Page } from '@playwright/test';
import { sessionHeaders } from '../../../packages/verify/src/web/session.js';

export { createTestAccount } from '../../../packages/verify/src/web/auth-account.js';
export { signInToStack as signIn, stackConvexUrl } from '../../../packages/verify/src/web/browser-setup.js';

export async function apiRequest(page: Page, method: 'get' | 'post', url: string, options: NonNullable<Parameters<APIRequestContext['fetch']>[1]> = {}) {
  return page.request.fetch(url, {
    ...options,
    method: method.toUpperCase(),
    headers: { ...options.headers, ...await sessionHeaders(page) },
  });
}
