/** praxis-browser against its fixture page; Cloud / verify-web runs it because the test job has no Chromium. */
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runCommand} from '../src/commands.js';

const fixture = pathToFileURL(resolve(fileURLToPath(import.meta.url), '../../fixtures/login.html')).href;
const directory = mkdtempSync(join(tmpdir(), 'praxis-browser-check-'));
const session = join(directory, 'session.json');
const run = (command: string, ...args: string[]) => runCommand(session, command, args, {headed: false});

try {
  await run('open');
  assert.equal((await run('goto', fixture)).title, 'Fixture sign-in');
  const first = String((await run('snapshot')).snapshot);
  assert.match(first, /link "Docs" \[ref=e1\]/);
  assert.match(first, /link "Docs" \[ref=e2\]/);
  assert.match(first, /button "Sign in" \[ref=e6\]/);
  assert.equal(String((await run('snapshot')).snapshot), first, 'a second snapshot of the same page must give identical refs');
  await run('type', 'e3', 'ada@example.com');
  await run('click', 'e5');
  await run('click', 'button:Sign in');
  await run('wait-for', 'button:Continue');
  assert.match(String((await run('snapshot')).snapshot), /heading "Welcome, ada@example.com"/);
  await assert.rejects(run('click', 'e99'), /unknown ref e99/);
  await assert.rejects(run('click', 'button:Does not exist'), /Timeout/);
  const shot = await run('screenshot', join(directory, 'fixture.png'));
  assert.match(String(shot.sha256), /^[a-f0-9]{64}$/);
  console.log(`praxis-browser fixture check: ok (screenshot ${String(shot.sha256).slice(0, 12)}, ${shot.bytes} bytes)`);
} finally {
  await run('close').catch(() => undefined);
  rmSync(directory, {recursive: true, force: true});
}
