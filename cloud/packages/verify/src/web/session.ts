import type { Page } from '@playwright/test';
import { VERIFY_AUTH } from '../../../../verify/auth/constants.js';

const API_CLIENT_MODULE = '/src/lib/api.ts';

/** Browser and direct-request checks share a real Convex Auth session, never a dev-token route. */
export async function signIn(page: Page, base: string): Promise<void> {
  await page.goto(base);
  const login = page.getByRole('button', { name: 'Sign in', exact: true });
  await Promise.race([login.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await login.isVisible()) {
    await page.getByLabel('Email', { exact: true }).fill(VERIFY_AUTH.email);
    await page.getByLabel('Password', { exact: true }).fill(VERIFY_AUTH.password);
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
