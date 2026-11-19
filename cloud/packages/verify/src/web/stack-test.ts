import { test as base } from '@playwright/test';
import { createTestAccount } from './auth-account.js';
import { stackConvexUrl } from './browser-setup.js';
import { readSessionState, signIn, type SessionState } from './session.js';

interface StackSession { baseURL: string; state: SessionState }

// Signed-out specs register the same lazy worker fixture so they can run between signed-in specs.
export const stackTest = base.extend<Record<never, never>, { stackSession: StackSession }>({
  stackSession: [async ({ browser }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL;
    if (!baseURL) throw new Error('The verification browser project requires a baseURL');
    const context = await browser.newContext();
    let state: SessionState;
    try {
      const account = await createTestAccount(stackConvexUrl());
      await signIn(await context.newPage(), baseURL, account);
      state = await readSessionState(context, baseURL);
    } finally {
      await context.close();
    }
    await use({ baseURL, state });
  }, { scope: 'worker' }],
});

export const signedInTest = stackTest.extend<{ persistStackSession: void }>({
  storageState: async ({ stackSession }, use) => use(stackSession.state),
  // A fresh context must start with the last rotated token pair and clean app storage.
  persistStackSession: [async ({ context, stackSession }, use) => {
    await use();
    stackSession.state = await readSessionState(context, stackSession.baseURL);
  }, { auto: true }],
});
