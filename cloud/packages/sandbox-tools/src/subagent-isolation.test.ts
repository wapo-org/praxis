import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {localExec} from './local.js';
import {FILE_OPERATION} from './subagent-isolation.js';

it('the real file helper rejects symlinks, special files and records immutable executable bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-confined-'));
  try {
    const root = join(directory, 'child');
    await mkdir(root);
    await writeFile(join(root, 'script'), 'echo verified', {mode: 0o700});
    const run = (op: string, path = '', payload = '') => localExec({argv: ['python3', '-c', FILE_OPERATION, root, op, path, payload], cwd: directory, timeoutMs: 5000});
    const snapshot = await run('capture');
    expect(snapshot.exitCode).toBe(0);
    expect(JSON.parse(snapshot.stdout)).toEqual([{path: 'script', data: Buffer.from('echo verified').toString('base64'), executable: true}]);
    await symlink(join(root, 'script'), join(root, 'link'));
    expect((await run('read', 'link')).exitCode).not.toBe(0);
    expect((await run('write', 'link', Buffer.from('overwrite').toString('base64'))).exitCode).not.toBe(0);
    expect((await run('capture')).exitCode).not.toBe(0);
    await symlink(directory, join(root, 'outside'));
    expect((await run('write', 'outside/escape', '')).exitCode).not.toBe(0);
    expect((await run('read', '../child/script')).exitCode).not.toBe(0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
