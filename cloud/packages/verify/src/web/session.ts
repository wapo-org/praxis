import { JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from '@convex-dev/auth/browser';
import type { BrowserContext, Page } from '@playwright/test';
import type { TestAccount } from './auth-account.js';

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;
const API_CLIENT_MODULE = '/src/lib/api.ts';

export async function signIn(page: Page, base: string, account: TestAccount): Promise<void> {
  await page.goto(base, { waitUntil: 'commit' });
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const chat = page.getByTestId('chat-top-bar');
  const error = page.getByRole('alert');
  await chat.or(error).first().waitFor();
  if (await error.isVisible()) throw new Error(`Convex Auth sign-in failed: ${await error.textContent()}`);
}

export async function openSignedInPage(page: Page, path = '/', base = '/'): Promise<void> {
  await page.goto(base, { waitUntil: 'commit' });
  await page.getByTestId('chat-top-bar').waitFor();
  if (path !== '/') await page.goto(path);
}

export async function readSessionState(context: BrowserContext, base: string): Promise<SessionState> {
  const { origins } = await context.storageState();
  const origin = origins.find(item => item.origin === new URL(base).origin);
  const localStorage = origin?.localStorage.filter(({name}) =>
    name.startsWith(`${JWT_STORAGE_KEY}_`) || name.startsWith(`${REFRESH_TOKEN_STORAGE_KEY}_`));
  if (localStorage?.length !== 2 || !origin) throw new Error('The browser has no reusable Convex Auth session');
  return { cookies: [], origins: [{ origin: origin.origin, localStorage }] };
}

export async function sessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(async path => {
    const module: { apiClient: { freshToken(): Promise<string> } } = await import(path);
    return module.apiClient.freshToken();
  }, API_CLIENT_MODULE);
  if (!token) throw new Error('The browser has no Convex Auth session');
  return token;
}

export async function sessionHeaders(page: Page): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await sessionToken(page)}` };
}
