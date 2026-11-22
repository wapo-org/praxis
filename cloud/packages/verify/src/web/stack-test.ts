import { test as base } from '@playwright/test';
import { PW_WORKER_SESSIONS_ENV } from '../constants.js';
import { createTestAccount } from './auth-account.js';
import { stackConvexUrl } from './browser-setup.js';
import { readSessionState, signIn, type SessionState } from './session.js';
import { restoreWorkerSession, saveWorkerSession, workerSessionPath } from './worker-session.js';

interface StackSession { baseURL: string; path: string; state: SessionState }

// Signed-out specs register the same lazy worker fixture so they can run between signed-in specs.
export const stackTest = base.extend<Record<never, never>, { stackSession: StackSession }>({
  stackSession: [async ({ browser }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL;
    if (!baseURL) throw new Error('The verification browser project requires a baseURL');
    const directory = process.env[PW_WORKER_SESSIONS_ENV];
    if (!directory) throw new Error('The verification worker session directory was not initialized');
    // Playwright assigns a replacement process the same parallelIndex and a new workerIndex.
    const path = workerSessionPath(directory, workerInfo.project.name, workerInfo.parallelIndex);
    const state = await restoreWorkerSession(path, () => createTestAccount(stackConvexUrl()), async account => {
      const context = await browser.newContext();
      try {
        await signIn(await context.newPage(), baseURL, account);
        return await readSessionState(context, baseURL);
      } finally {
        await context.close();
      }
    });
    await use({ baseURL, path, state });
  }, { scope: 'worker' }],
});

export const signedInTest = stackTest.extend<{ persistStackSession: void }>({
  storageState: async ({ stackSession }, use) => use(stackSession.state),
  // A fresh context must start with the last rotated token pair and clean app storage.
  persistStackSession: [async ({ context, stackSession }, use) => {
    await use();
    const state = await readSessionState(context, stackSession.baseURL);
    await saveWorkerSession(stackSession.path, state);
    stackSession.state = state;
  }, { auto: true }],
});
