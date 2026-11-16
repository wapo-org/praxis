import {posix} from 'node:path';
import {GIT_TIMEOUT_MS, PRAXIS_DIR} from './constants.js';
import type {SandboxPort} from './port.js';
import {capOutput, fail} from './support.js';

/** Commits made by the runner carry this trailer, so rewind can refuse commits a user or agent made by hand. */
export const CHECKPOINT_TRAILER = 'Praxis-Turn';
const AUTHOR = ['-c', 'user.name=Praxis', '-c', 'user.email=checkpoints@praxis.invalid'];
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const GIT_ENV = {GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'};

export interface Checkpoint {
  sha: string;
  turnId: string;
  subject: string;
}

async function git(port: SandboxPort, root: string, args: string[]) {
  const result = await port.exec({argv: ['git', ...AUTHOR, ...args], cwd: root, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS});
  if (result.timedOut) fail('timeout', `git ${args[0]} exceeded ${GIT_TIMEOUT_MS} ms.`);
  return result;
}

async function gitOk(port: SandboxPort, root: string, args: string[]): Promise<string> {
  const result = await git(port, root, args);
  if (result.exitCode !== 0) fail('upstream', `git ${args[0]} failed: ${capOutput(result.stderr || result.stdout, 2_000).text.trim()}`);
  return result.stdout;
}

/** One repository per chat directory; the tools' own `.praxis/` stays out of every commit. */
export async function ensureRepository(port: SandboxPort, root: string): Promise<void> {
  if (await port.stat(posix.join(root, '.git'))) return;
  await gitOk(port, root, ['init', '-q']);
  await port.writeFile(posix.join(root, '.git', 'info', 'exclude'), new TextEncoder().encode(`${PRAXIS_DIR}/\n`));
}

/** Called by the runner at the end of every turn: one commit if the turn changed files, none otherwise. */
export async function checkpointTurn(port: SandboxPort, root: string, turnId: string): Promise<{sha: string | null; files: string[]}> {
  await ensureRepository(port, root);
  await gitOk(port, root, ['add', '-A']);
  const staged = await git(port, root, ['diff', '--cached', '--quiet']);
  if (staged.exitCode === 0) return {sha: null, files: []};
  await gitOk(port, root, ['commit', '-q', '--no-verify', '-m', `turn ${turnId}`, '-m', `${CHECKPOINT_TRAILER}: ${turnId}`]);
  const sha = (await gitOk(port, root, ['rev-parse', 'HEAD'])).trim();
  const files = (await gitOk(port, root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
  return {sha, files};
}

export async function listCheckpoints(port: SandboxPort, root: string, limit = 50): Promise<Checkpoint[]> {
  if (!(await port.stat(posix.join(root, '.git')))) return [];
  const head = await git(port, root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.exitCode !== 0) return [];
  const log = await gitOk(port, root, ['log', `-n${limit}`, `--format=%H%x09%s%x09%(trailers:key=${CHECKPOINT_TRAILER},valueonly)`]);
  return log.split('\n').filter(Boolean).flatMap(line => {
    const [sha = '', subject = '', turnId = ''] = line.split('\t');
    return turnId.trim() ? [{sha, subject, turnId: turnId.trim()}] : [];
  });
}

/** What changed since a checkpoint, for review or a diff view; capped like any tool output. */
export async function diffSince(port: SandboxPort, root: string, sha: string): Promise<{stat: string; patch: string; truncated: boolean}> {
  if (!COMMIT_SHA.test(sha)) fail('schema', 'Checkpoint ids are 40-character commit hashes.');
  const stat = await gitOk(port, root, ['diff', '--stat', sha]);
  const patch = capOutput(await gitOk(port, root, ['diff', sha]));
  return {stat, patch: patch.text, truncated: patch.truncated};
}

/** PRA-63 rewind: the working tree returns exactly to a checkpoint the runner made; `.praxis/` survives. */
export async function rewindTo(port: SandboxPort, root: string, sha: string): Promise<void> {
  if (!COMMIT_SHA.test(sha)) fail('schema', 'Checkpoint ids are 40-character commit hashes.');
  const known = await listCheckpoints(port, root, 1_000);
  if (!known.some(checkpoint => checkpoint.sha === sha)) fail('not-found', `${sha} is not a Praxis checkpoint in this chat.`);
  await gitOk(port, root, ['reset', '-q', '--hard', sha]);
  await gitOk(port, root, ['clean', '-fdq', '-e', `${PRAXIS_DIR}/`]);
}
