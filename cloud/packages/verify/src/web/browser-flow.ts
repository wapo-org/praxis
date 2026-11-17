import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CLOUD_DIR} from '../constants.js';
import {runCommand} from '../proc.js';
import type {WebFlow} from './flow-types.js';

const BIN = join(CLOUD_DIR, 'packages', 'browser-cli', 'bin', 'praxis-browser.mjs');
const FIXTURE = pathToFileURL(join(CLOUD_DIR, 'packages', 'browser-cli', 'fixtures', 'login.html')).href;

type CliResult = {ok: boolean; error?: string} & Record<string, unknown>;

/** The real `praxis-browser` binary, one process per command, exactly as an agent in a sandbox runs it. */
async function cli(session: string, ...args: string[]): Promise<CliResult> {
  const result = await runCommand('node', [BIN, '--session', session, ...args], {cwd: CLOUD_DIR});
  const line = result.output.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as CliResult;
}

async function ok(session: string, ...args: string[]): Promise<CliResult> {
  const result = await cli(session, ...args);
  assert(result.ok, `praxis-browser ${args.join(' ')} failed: ${result.error}`);
  return result;
}

/** PRA-77: deterministic refs, role:name targets, waits and hashed screenshots on a static page, with no LLM. */
export const browserCliFlow: WebFlow = {
  id: 'browser-cli',
  title: 'praxis-browser drives the static fixture by accessibility refs and role:name, deterministically',
  default: true,
  allow: [],
  async run({note}) {
    const directory = mkdtempSync(join(tmpdir(), 'praxis-browser-flow-'));
    const session = join(directory, 'session.json');
    try {
      await ok(session, 'open');
      assert.equal((await ok(session, 'goto', FIXTURE)).title, 'Fixture sign-in');
      const first = String((await ok(session, 'snapshot')).snapshot);
      assert.match(first, /link "Docs" \[ref=e1\]/);
      assert.match(first, /link "Docs" \[ref=e2\]/);
      assert.match(first, /button "Sign in" \[ref=e6\]/);
      assert.equal(String((await ok(session, 'snapshot')).snapshot), first, 'the same page must give identical refs');
      await ok(session, 'type', 'e3', 'ada@example.com');
      await ok(session, 'click', 'e5');
      await ok(session, 'click', 'button:Sign in');
      await ok(session, 'wait-for', 'button:Continue');
      assert.match(String((await ok(session, 'snapshot')).snapshot), /heading "Welcome, ada@example.com"/);
      assert.match((await cli(session, 'click', 'e99')).error ?? '', /unknown ref e99/);
      assert.match((await cli(session, 'click', 'button:Does not exist')).error ?? '', /Timeout/);
      const shot = await ok(session, 'screenshot', join(directory, 'fixture.png'));
      assert.match(String(shot.sha256), /^[a-f0-9]{64}$/);
      note(`screenshot sha256 ${String(shot.sha256).slice(0, 12)}`);
    } finally {
      await cli(session, 'close').catch(() => undefined);
      rmSync(directory, {recursive: true, force: true});
    }
  },
};
