import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createAuthChallengeBudget, reserveAuthChallenge } from './auth-budget.js';

test('concurrent browser workers reserve at most 19 signup or recovery challenges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-auth-budget-test-'));
  try {
    const budget = await createAuthChallengeBudget(directory);
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAuthChallenge(budget)));
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(19);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Convex Auth signup and recovery budget exhausted') }) },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
