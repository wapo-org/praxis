import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PW_AUTH_CHALLENGE_BUDGET_ENV } from '../constants.js';

// Convex Auth v2 shares a 20-per-IP hourly bucket across signup and recovery.
const AUTH_CHALLENGES_PER_RUN_MAX = 19;

export async function createAuthChallengeBudget(directory: string): Promise<string> {
  const budget = join(directory, 'auth-challenges');
  await mkdir(budget);
  return budget;
}

export async function reserveAuthChallenge(directory = process.env[PW_AUTH_CHALLENGE_BUDGET_ENV]): Promise<void> {
  if (!directory) throw new Error('The Convex Auth challenge budget was not initialized');
  // Atomic slot claims count attempts across both browser projects and worker restarts.
  for (let slot = 1; slot <= AUTH_CHALLENGES_PER_RUN_MAX; slot++) {
    try {
      await mkdir(join(directory, String(slot)));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(
    `Convex Auth signup and recovery budget exhausted (up to ${AUTH_CHALLENGES_PER_RUN_MAX} challenges per run).` +
    ' Reuse a worker session or start a fresh isolated Convex verification stack.',
  );
}
