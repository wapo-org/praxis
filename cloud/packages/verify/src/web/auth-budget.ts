import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PW_AUTH_CHALLENGE_BUDGET_ENV } from '../constants.js';

// @convex-dev/auth 2.0.0 startChallengePerIp: 20 sign-up/recovery challenges per IP per hour, shared by the whole run.
export const SIGNUP_CHALLENGES_PER_IP_HOUR_MAX = 20;

export function signupBudgetExceeded(count: number): Error {
  return new Error(
    `Convex Auth sign-up budget exceeded: challenge ${count} > ${SIGNUP_CHALLENGES_PER_IP_HOUR_MAX} per IP per hour.` +
    ` One Convex stack per run allows at most ${SIGNUP_CHALLENGES_PER_IP_HOUR_MAX} sign-ups,` +
    ' so reuse signedInTest instead of creating accounts.',
  );
}

export async function createAuthChallengeBudget(directory: string): Promise<string> {
  const budget = join(directory, 'auth-challenges');
  await mkdir(budget);
  return budget;
}

export async function countAuthChallenges(directory: string): Promise<number> {
  return (await readdir(directory)).length;
}

export async function reserveAuthChallenge(directory = process.env[PW_AUTH_CHALLENGE_BUDGET_ENV]): Promise<void> {
  if (!directory) throw new Error('The Convex Auth challenge budget was not initialized');
  // Atomic slot claims count attempts across both browser projects and worker restarts.
  for (let slot = 1; slot <= SIGNUP_CHALLENGES_PER_IP_HOUR_MAX; slot++) {
    try {
      await mkdir(join(directory, String(slot)));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw signupBudgetExceeded(SIGNUP_CHALLENGES_PER_IP_HOUR_MAX + 1);
}
