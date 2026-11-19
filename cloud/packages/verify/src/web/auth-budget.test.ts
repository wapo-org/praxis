import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseSignupReply } from './auth-account.js';
import { countAuthChallenges, createAuthChallengeBudget, reserveAuthChallenge, SIGNUP_CHALLENGES_PER_IP_HOUR_MAX } from './auth-budget.js';

const budgetPattern = /challenge 21 > 20 per IP per hour\. One Convex stack per run allows at most 20 sign-ups, so reuse signedInTest/;
const budgetMessage = expect.stringMatching(budgetPattern);
let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'praxis-auth-budget-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('reservations up to the per-IP budget succeed and are counted', async () => {
  const budget = await createAuthChallengeBudget(directory);
  await Promise.all(Array.from({ length: SIGNUP_CHALLENGES_PER_IP_HOUR_MAX }, () => reserveAuthChallenge(budget)));
  expect(await countAuthChallenges(budget)).toBe(SIGNUP_CHALLENGES_PER_IP_HOUR_MAX);
});

test('concurrent workers past the budget get the clear sign-up budget error', async () => {
  const budget = await createAuthChallengeBudget(directory);
  const attempts = await Promise.allSettled(
    Array.from({ length: SIGNUP_CHALLENGES_PER_IP_HOUR_MAX + 1 }, () => reserveAuthChallenge(budget)),
  );
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(SIGNUP_CHALLENGES_PER_IP_HOUR_MAX);
  expect(attempts.filter(attempt => attempt.status === 'rejected')).toEqual([
    { status: 'rejected', reason: expect.objectContaining({ message: budgetMessage }) },
  ]);
});

test('a rate-limited success:false sign-up reply maps to the clear budget error', () => {
  expect(() => parseSignupReply({ success: false, userError: { error: 'RATE_LIMITED', retryAfterMs: 1000 } }))
    .toThrow(budgetPattern);
  expect(() => parseSignupReply({ success: false })).toThrow(budgetPattern);
});

test('a successful sign-up reply yields the browser secret', () => {
  expect(parseSignupReply({ success: true, browserSecret: 'secret' })).toBe('secret');
});
