import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium, type Browser, type Page} from '@playwright/test';
import {z} from 'zod';
import type {RefTarget} from './refs.js';

/** Chromium writes its CDP port here once it listens; reading it avoids picking a port ourselves. */
const PORT_FILE = 'DevToolsActivePort';
const LAUNCH_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
/** Same size as praxis-verify flows, so screenshots and snapshots from both tools compare. */
export const VIEWPORT = {width: 1280, height: 860};

const SessionSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  profile: z.string(),
  refs: z.record(z.string(), z.object({role: z.string(), name: z.string(), nth: z.number().int().nonnegative()})).default({}),
}).strict();
export type Session = z.infer<typeof SessionSchema>;

export function readSession(file: string): Session {
  if (!existsSync(file)) throw new Error(`no browser session at ${file}; run praxis-browser open first`);
  return SessionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function writeSession(file: string, session: Session): void {
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
}

/** Starts Chromium detached with remote debugging on a private profile; later commands attach over CDP. */
export async function openSession(file: string, headed: boolean): Promise<Session> {
  if (existsSync(file)) throw new Error(`a session already exists at ${file}; run praxis-browser close first`);
  const profile = mkdtempSync(join(tmpdir(), 'praxis-browser-'));
  const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, ...(headed ? [] : ['--headless=new']), 'about:blank'];
  const child = spawn(chromium.executablePath(), args, {detached: true, stdio: 'ignore'});
  child.unref();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!existsSync(join(profile, PORT_FILE))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      if (child.pid) process.kill(child.pid);
      throw new Error('Chromium did not open its debugging port');
    }
    await sleep(POLL_MS);
  }
  const port = Number.parseInt(readFileSync(join(profile, PORT_FILE), 'utf8').split('\n')[0]!, 10);
  const session = {pid: child.pid!, port, profile, refs: {}};
  writeSession(file, session);
  return session;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops only the Chromium this session started, waits for it to exit, then removes its profile and the session file. */
export async function closeSession(file: string): Promise<void> {
  const session = readSession(file);
  if (alive(session.pid)) process.kill(session.pid);
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (alive(session.pid) && Date.now() < deadline) await sleep(POLL_MS);
  rmSync(session.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: POLL_MS});
  rmSync(file, {force: true});
}

export async function attach(session: Session): Promise<{browser: Browser; page: Page}> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('the session browser has no context');
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setViewportSize(VIEWPORT);
  return {browser, page};
}

export function resolveRef(session: Session, ref: string): RefTarget {
  const target = session.refs[ref];
  if (!target) throw new Error(`unknown ref ${ref}; take a fresh snapshot (refs come from the last one)`);
  return target;
}
