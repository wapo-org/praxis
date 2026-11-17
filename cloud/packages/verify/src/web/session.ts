import type { BrowserContext, Page } from '@playwright/test';
import { createTestAccount, type TestAccount } from './auth-account.js';

const accounts = new WeakMap<BrowserContext, Promise<TestAccount>>();

const API_CLIENT_MODULE = '/src/lib/api.ts';

/** Browser and direct-request checks share a real Convex Auth session, never a dev-token route. */
export async function signIn(page: Page, base: string, convexUrl: string, sharedAccount?: TestAccount): Promise<void> {
  let account = sharedAccount ? Promise.resolve(sharedAccount) : accounts.get(page.context());
  if (!account) {
    account = createTestAccount(convexUrl);
    accounts.set(page.context(), account);
  }
  const credentials = await account;
  await page.goto(base);
  const login = page.getByRole('button', { name: 'Sign in', exact: true });
  await Promise.race([login.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await login.isVisible()) {
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await login.click();
  }
  await page.getByTestId('chat-top-bar').waitFor();
}
export async function sessionHeaders(page: Page): Promise<{ Authorization: string }> {
  const token = await page.evaluate(async path => {
    const module: { apiClient: { freshToken(): Promise<string> } } = await import(path);
    return module.apiClient.freshToken();
  }, API_CLIENT_MODULE);
  if (!token) throw new Error('The browser has no Convex Auth session');
  return { Authorization: `Bearer ${token}` };
}
