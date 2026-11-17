import { test as base, type BrowserContextOptions } from '@playwright/test';
import { signInToStack } from './browser-setup.js';

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;
interface StackSession { state: StorageState }

// Auth v2 rate-limits sign-ups per IP and password checks per account, so tests share one real session per worker.
export const signedInTest = base.extend<{ persistStackSession: void }, { stackSession: StackSession }>({
  stackSession: [async ({ browser }, use, workerInfo) => {
    const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
    await signInToStack(await context.newPage());
    const session = { state: await context.storageState() };
    await context.close();
    await use(session);
  }, { scope: 'worker' }],
  storageState: async ({ stackSession }, use) => use(stackSession.state),
  // Refresh tokens rotate on use; the next test must start from the rotated pair, or reuse detection revokes the session.
  persistStackSession: [async ({ context, stackSession }, use) => {
    await use();
    stackSession.state = await context.storageState();
  }, { auto: true }],
});
