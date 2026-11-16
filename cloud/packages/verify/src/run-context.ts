import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync} from 'node:fs';
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

/** Root-owned on Linux runners, the Modal image and macOS (Xcode shim); a writable PATH entry can't shadow it. */
const GIT_LOCATIONS = ['/usr/bin/git'];

/** A proof names the exact tree it ran against; `unknown` and dirty when no trusted git or checkout is found. */
export function gitState(git = GIT_LOCATIONS.find(path => existsSync(path))): GitState {
  if (!git) return {sha: 'unknown', dirty: true};
  try {
    const sha = execFileSync(git, ['rev-parse', 'HEAD'], {cwd: REPO_DIR, encoding: 'utf8'}).trim();
    const status = execFileSync(git, ['status', '--porcelain'], {cwd: REPO_DIR, encoding: 'utf8'});
    return {sha, dirty: status.trim().length > 0};
  } catch {
    return {sha: 'unknown', dirty: true};
  }
}
