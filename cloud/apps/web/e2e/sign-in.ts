import type { APIRequestContext, Page } from '@playwright/test';
import { signIn as signInWithConvex, sessionHeaders } from '../../../packages/verify/src/web/session.js';

export { createTestAccount } from '../../../packages/verify/src/web/auth-account.js';
import type { TestAccount } from '../../../packages/verify/src/web/auth-account.js';

export async function signIn(page: Page, path = '/', account?: TestAccount) {
  const convexUrl = process.env.PW_CONVEX_URL;
  if (!convexUrl) throw new Error('PW_CONVEX_URL is required for real-auth browser tests');
  await signInWithConvex(page, '/', convexUrl, account);
  if (path !== '/') await page.goto(path);
}


export async function apiRequest(page: Page, method: 'get' | 'post', url: string, options: NonNullable<Parameters<APIRequestContext['fetch']>[1]> = {}) {
  return page.request.fetch(url, {
    ...options,
    method: method.toUpperCase(),
    headers: { ...options.headers, ...await sessionHeaders(page) },
  });
}
