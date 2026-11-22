import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { restoreWorkerSession, saveWorkerSession, workerSessionPath } from './worker-session.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'praxis-worker-session-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function session(refreshToken: string) {
  return {
    cookies: [],
    origins: [{ origin: 'http://127.0.0.1:5240', localStorage: [
      { name: 'jwt', value: 'test-jwt' },
      { name: 'refresh', value: refreshToken },
    ] }],
  };
}

test('a replacement process restores the last rotated session in its project and parallel slot', async () => {
  const createAccount = vi.fn(async () => ({ email: 'worker@example.test', password: 'test-password' }));
  const signIn = vi.fn(async () => session('initial-token'));
  const original = workerSessionPath(directory, 'chromium', 0);
  await expect(restoreWorkerSession(original, createAccount, signIn)).resolves.toEqual(session('initial-token'));
  await saveWorkerSession(original, session('rotated-token'));

  const replacement = workerSessionPath(directory, 'chromium', 0);
  await expect(restoreWorkerSession(replacement, createAccount, signIn)).resolves.toEqual(session('rotated-token'));
  expect(createAccount).toHaveBeenCalledTimes(1);
  expect(signIn).toHaveBeenCalledTimes(1);

  const otherProject = workerSessionPath(directory, 'webkit', 0);
  const otherSlot = workerSessionPath(directory, 'chromium', 1);
  await restoreWorkerSession(otherProject, createAccount, signIn);
  await restoreWorkerSession(otherSlot, createAccount, signIn);
  expect(createAccount).toHaveBeenCalledTimes(3);
});

test('an interrupted initial sign-in retries with the same provisioned account', async () => {
  const account = { email: 'worker@example.test', password: 'test-password' };
  const createAccount = vi.fn(async () => account);
  const signIn = vi.fn(async () => session('first-token')).mockRejectedValueOnce(new Error('Browser closed'));
  const path = workerSessionPath(directory, 'chromium', 0);
  await expect(restoreWorkerSession(path, createAccount, signIn)).rejects.toThrow('Browser closed');
  await expect(restoreWorkerSession(path, createAccount, signIn)).resolves.toEqual(session('first-token'));
  expect(createAccount).toHaveBeenCalledTimes(1);
  expect(signIn.mock.calls).toEqual([[account], [account]]);
});

test('repeated initial sign-in failures leave the password retry budget intact', async () => {
  const createAccount = vi.fn(async () => ({ email: 'worker@example.test', password: 'test-password' }));
  const signIn = vi.fn(async () => { throw new Error('Browser closed'); });
  const path = workerSessionPath(directory, 'chromium', 0);
  await expect(restoreWorkerSession(path, createAccount, signIn)).rejects.toThrow('Browser closed');
  await expect(restoreWorkerSession(path, createAccount, signIn)).rejects.toThrow('Browser closed');
  await expect(restoreWorkerSession(path, createAccount, signIn)).rejects.toThrow('after two attempts');
  expect(createAccount).toHaveBeenCalledTimes(1);
  expect(signIn).toHaveBeenCalledTimes(2);
});
