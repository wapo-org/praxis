import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { TestAccount } from './auth-account.js';
import type { SessionState } from './session.js';

const Checkpoint = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    account: z.object({ email: z.email(), password: z.string() }),
    attempt: z.union([z.literal(1), z.literal(2)]),
  }),
  z.object({
    kind: z.literal('session'),
    state: z.object({
      cookies: z.tuple([]),
      origins: z.tuple([z.object({
        origin: z.url(),
        localStorage: z.array(z.object({ name: z.string(), value: z.string() })).length(2),
      })]),
    }),
  }),
]);

export function workerSessionPath(directory: string, project: string, parallelIndex: number): string {
  return join(directory, `${encodeURIComponent(project)}-${parallelIndex}.json`);
}

async function readCheckpoint(path: string): Promise<z.infer<typeof Checkpoint> | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return Checkpoint.parse(JSON.parse(text));
  } catch {
    throw new Error('The verification worker session checkpoint is invalid');
  }
}

async function writeCheckpoint(
  path: string,
  checkpoint: { kind: 'account'; account: TestAccount; attempt: 1 | 2 } | { kind: 'session'; state: SessionState },
): Promise<void> {
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify(checkpoint), { mode: 0o600 });
  await rename(pending, path);
}

export async function saveWorkerSession(path: string, state: SessionState): Promise<void> {
  await writeCheckpoint(path, { kind: 'session', state });
}

export async function restoreWorkerSession(
  path: string,
  createAccount: () => Promise<TestAccount>,
  signIn: (account: TestAccount) => Promise<SessionState>,
): Promise<SessionState> {
  const saved = await readCheckpoint(path);
  if (saved?.kind === 'session') return saved.state;
  if (saved?.attempt === 2) throw new Error('The verification worker could not establish its Convex Auth session after two attempts');
  const account = saved?.account ?? await createAccount();
  // A broken initial sign-in must never consume Convex Auth's five password attempts.
  await writeCheckpoint(path, { kind: 'account', account, attempt: saved ? 2 : 1 });
  const state = await signIn(account);
  await saveWorkerSession(path, state);
  return state;
}
