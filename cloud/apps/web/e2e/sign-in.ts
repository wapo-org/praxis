import type { APIRequestContext, Page } from '@playwright/test';
import { signIn as signInWithConvex, sessionHeaders } from '../../../packages/verify/src/web/session.js';

export async function signIn(page: Page, path = '/') {
  await signInWithConvex(page, '/');
  if (path !== '/') await page.goto(path);
}


export async function apiRequest(page: Page, method: 'get' | 'post', url: string, options: NonNullable<Parameters<APIRequestContext['fetch']>[1]> = {}) {
  return page.request.fetch(url, {
    ...options,
    method: method.toUpperCase(),
    headers: { ...options.headers, ...await sessionHeaders(page) },
  });
}
