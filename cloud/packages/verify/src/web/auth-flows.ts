import { JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from '@convex-dev/auth/browser';
import { expect, type Page } from '@playwright/test';
import { LOOPBACK_HOST } from '../constants.js';
import type { WebFlow } from './flow-types.js';
import { seedUnavailableAccount } from './auth-account.js';
import { sessionToken } from './session.js';

function browserAccountState(page: Page) {
  return page.evaluate(async ({jwtKey, refreshKey}) => {
    const apiPath = '/src/lib/api.ts';
    const replicaPath = '/src/lib/idb.ts';
    const {apiClient}: {apiClient: {getBearerToken(): string; getSessionSignal(): AbortSignal}} = await import(apiPath);
    const {getReplicaIdentity}: {getReplicaIdentity(): string | undefined} = await import(replicaPath);
    const keys = Object.keys(localStorage);
    return {
      hasAccess: keys.some(key => key.startsWith(jwtKey + '_')),
      hasRefresh: keys.some(key => key.startsWith(refreshKey + '_')),
      hasApiBearer: apiClient.getBearerToken() !== '',
      hasReplicaOwner: getReplicaIdentity() !== undefined,
      requestsAborted: apiClient.getSessionSignal().aborted,
    };
  }, {jwtKey: JWT_STORAGE_KEY, refreshKey: REFRESH_TOKEN_STORAGE_KEY});
}

export const unavailableAccountFlow: WebFlow = {
  id: 'unavailable-account',
  title: 'A signed-in browser with a missing owner hides private UI and can sign out',
  default: true,
  session: 'isolated',
  allow: [],
  async run({page, convexUrl, note}) {
    await expect(page.getByRole('textbox', {name: 'Message Praxis'})).toBeEditable();
    await expect.poll(() => browserAccountState(page)).toEqual({
      hasAccess: true, hasRefresh: true, hasApiBearer: true, hasReplicaOwner: true, requestsAborted: false,
    });
    const token = await sessionToken(page);
    // A mounted shell would race its own owner requests against the removal, so seed while the app is unloaded.
    await page.goto('about:blank');
    const isAuthenticated = await seedUnavailableAccount(convexUrl, token);
    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveText('This account is unavailable.');
    expect(await isAuthenticated()).toBe(true);
    await expect(page.getByTestId('chat-screen')).toHaveCount(0);
    await expect(page.getByTestId('nav-settings-button')).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Retry account deletion'})).toHaveCount(0);
    note('The real Convex session remained valid while the private shell was unmounted.');

    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
    await expect(signIn).toBeEnabled();
    await expect.poll(() => browserAccountState(page)).toEqual({
      hasAccess: false, hasRefresh: false, hasApiBearer: false, hasReplicaOwner: false, requestsAborted: true,
    });
    await expect.poll(isAuthenticated).toBe(false);
    await page.reload();
    await expect(signIn).toBeEnabled();
    await expect(page.getByTestId('chat-screen')).toHaveCount(0);
    note('Browser auth and replica scope cleared, Convex revoked the session, and reload stayed signed out.');
  },
};

export const previewProviderFlow: WebFlow = {
  id: 'preview-provider-guidance',
  title: 'Preview simulations explain both provider failures and keep email sign-in available',
  default: false,
  allow: [],
  async run({page, note}) {
    await page.route(url => url.hostname !== LOOPBACK_HOST, route => {
      return route.request().isNavigationRequest() ? route.abort() : route.continue();
    });
    await page.goto('/');
    for (const provider of ['Google', 'Apple']) {
      const button = page.getByRole('button', {name: `Continue with ${provider}`, exact: true});
      await button.click();
      await expect(page.getByRole('alert')).toHaveText(
        `This preview simulates an unavailable ${provider} sign-in. Use email to continue.`,
      );
      await expect(button).toBeEnabled();
      await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeEnabled();
      await expect(page.getByLabel('Email', {exact: true})).toBeEditable();
      note(`${provider} showed its own fallback and left the email form enabled.`);
    }
  },
};
