import { test as base, type BrowserContextOptions } from '@playwright/test';
import { signInToStack } from './browser-setup.js';

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

/**
 * Auth v2 limits sign-ups per IP and password checks per account, so each worker signs one account in once
 * and every test starts a fresh context from that real Convex session.
 */
export const signedInTest = base.extend<object, { stackSession: StorageState }>({
  stackSession: [async ({ browser }, use, workerInfo) => {
    const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
    await signInToStack(await context.newPage());
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: 'worker' }],
  storageState: async ({ stackSession }, use) => use(stackSession),
});
