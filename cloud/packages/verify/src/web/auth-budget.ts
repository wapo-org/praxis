import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PW_AUTH_CHALLENGE_BUDGET_ENV } from '../constants.js';

// @convex-dev/auth 2.0.0 startChallengePerIp: 20 sign-up/recovery challenges per IP per hour, shared by the whole run.
export const SIGNUP_CHALLENGES_PER_IP_HOUR_MAX = 20;
// Leave one challenge as headroom for an unreserved or retried challenge.
const SIGNUP_CHALLENGE_RESERVATIONS_MAX = SIGNUP_CHALLENGES_PER_IP_HOUR_MAX - 1;

export function signupBudgetExceeded(): Error {
  return new Error(
    `Convex Auth sign-up budget exceeded. The server allows ${SIGNUP_CHALLENGES_PER_IP_HOUR_MAX} challenges per IP per hour.` +
    ` The test run reserves up to ${SIGNUP_CHALLENGE_RESERVATIONS_MAX} sign-up and recovery challenges.` +
    ' Reuse signedInTest or start a fresh isolated Convex verification stack.',
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
  for (let slot = 1; slot <= SIGNUP_CHALLENGE_RESERVATIONS_MAX; slot++) {
    try {
      await mkdir(join(directory, String(slot)));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw signupBudgetExceeded();
}
