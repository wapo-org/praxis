import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {ARTIFACTS_DIR, REPO_DIR} from './constants.js';

/** Sortable and unique per run: `20261116T213000Z-a1b2c3`. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function artifactDir(...segments: string[]): string {
  const directory = join(ARTIFACTS_DIR, ...segments);
  mkdirSync(directory, {recursive: true});
  return directory;
}

export interface GitState {
  sha: string;
  dirty: boolean;
}

/** A proof names the exact tree it ran against; `unknown` only outside a git checkout. */
export function gitState(): GitState {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: REPO_DIR, encoding: 'utf8'}).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {cwd: REPO_DIR, encoding: 'utf8'});
    return {sha, dirty: status.trim().length > 0};
  } catch {
    return {sha: 'unknown', dirty: true};
  }
}
