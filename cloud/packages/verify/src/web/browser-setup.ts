import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { startLocalStack } from './servers.js';
import { signIn } from './session.js';
import type { TestAccount } from './auth-account.js';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from '../constants.js';

/** Set by the global setup for every worker; the auth deployment browser suites create accounts in. */
export const PW_CONVEX_URL_ENV = 'PW_CONVEX_URL';

export function stackConvexUrl(): string {
  const url = process.env[PW_CONVEX_URL_ENV];
  if (!url) throw new Error(`${PW_CONVEX_URL_ENV} is required for real-auth browser tests`);
  return url;
}

/** Signs a fresh per-context Convex account in, then opens `path`. */
export async function signInToStack(page: Page, path = '/', account?: TestAccount): Promise<void> {
  await signIn(page, '/', stackConvexUrl(), account);
  if (path !== '/') await page.goto(path);
}

export default async function setup() {
  if (process.env.PW_BASE_URL) {
    if (!process.env[PW_CONVEX_URL_ENV]) throw new Error(`Existing browser stacks require ${PW_CONVEX_URL_ENV} and the isolated verification auth deployment`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'praxis-browser-'));
  const stack = await startLocalStack({ web: DEFAULT_WEB_PORT, api: DEFAULT_API_PORT }, directory);
  process.env[PW_CONVEX_URL_ENV] = stack.convexUrl;
  return () => stack.stop();
}
