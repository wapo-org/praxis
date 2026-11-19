import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { startLocalStack } from './servers.js';
import { createAuthChallengeBudget } from './auth-budget.js';
import { signIn } from './session.js';
import type { TestAccount } from './auth-account.js';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, PW_AUTH_CHALLENGE_BUDGET_ENV, PW_CONVEX_URL_ENV } from '../constants.js';

export function stackConvexUrl(): string {
  const url = process.env[PW_CONVEX_URL_ENV];
  if (!url) throw new Error(`${PW_CONVEX_URL_ENV} is required for real-auth browser tests`);
  return url;
}

export async function signInToStack(page: Page, account: TestAccount): Promise<void> {
  await signIn(page, '/', account);
}

export default async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-browser-'));
  process.env[PW_AUTH_CHALLENGE_BUDGET_ENV] = await createAuthChallengeBudget(directory);
  if (process.env.PW_BASE_URL) {
    if (!process.env[PW_CONVEX_URL_ENV]) throw new Error(`Existing browser stacks require ${PW_CONVEX_URL_ENV} and the isolated verification auth deployment`);
    return;
  }
  const stack = await startLocalStack({ web: DEFAULT_WEB_PORT, api: DEFAULT_API_PORT }, directory);
  process.env[PW_CONVEX_URL_ENV] = stack.convexUrl;
  return () => stack.stop();
}
