import {mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import type {ExecRequest} from './port.js';
import {runDiagnostics} from './diagnostics.js';
import {localExec, localSandboxPort} from './local.js';
import {FILE_HELPER_PATH, fileOperation, SNAPSHOT_MAX_BYTES} from './subagent-isolation.js';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'praxis-confined-')));
  const root = join(directory, 'child');
  const control = join(directory, 'control');
  await mkdir(root);
  const port = localSandboxPort(join(directory, 'jobs'));
  const calls: ExecRequest[] = [];
  // Only mounts are translated: staged files, helper argv and Python execute through the real local process port.
  port.exec = async request => {
    calls.push(request);
    if (request.argv[0] !== 'bwrap') return localExec(request);
    const end = request.argv.indexOf('--');
    const mounts = new Map<string, string>();
    for (let index = 0; index < end; index++) {
      if (request.argv[index] === '--ro-bind' || request.argv[index] === '--bind') {
        mounts.set(request.argv[index + 2]!, request.argv[index + 1]!);
        index += 2;
      }
    }
    return localExec({...request, argv: request.argv.slice(end + 1).map(arg => mounts.get(arg) ?? arg),
      cwd: request.argv[request.argv.indexOf('--chdir') + 1]!, env: {PYTHONPATH: root, PYTHONHOME: root}});
  };
  const run = (op: 'read' | 'write' | 'capture', path = '', bytes: Uint8Array = new Uint8Array()) => fileOperation(port, root, root, op, path, bytes, control);
  return {directory, root, control, port, calls, run};
}

it('the real file helper rejects symlinks and records immutable executable bytes', async () => {
  const {directory, root, run} = await fixture();
  try {
    await writeFile(join(root, 'script'), 'echo verified', {mode: 0o700});
    expect(JSON.parse(await run('capture'))).toEqual([{path: 'script', data: Buffer.from('echo verified').toString('base64'), executable: true}]);
    await symlink(join(root, 'script'), join(root, 'link'));
    await expect(run('read', 'link')).rejects.toThrow();
    await expect(run('write', 'link', Buffer.from('overwrite'))).rejects.toThrow();
    await expect(run('capture')).rejects.toThrow();
    await symlink(directory, join(root, 'outside'));
    await expect(run('write', 'outside/escape')).rejects.toThrow();
    await expect(run('read', '../child/script')).rejects.toThrow();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('child-planted json.py/base64.py and PYTHON environment cannot forge reads or captures', async () => {
  const {directory, root, calls, run} = await fixture();
  try {
    const poison = "import os; os.write(1, b'FORGED'); os._exit(0)\n";
    await writeFile(join(root, 'json.py'), poison);
    await writeFile(join(root, 'base64.py'), poison);
    await writeFile(join(root, 'artifact'), 'actual bytes');
    expect(Buffer.from(await run('read', 'artifact'), 'base64').toString()).toBe('actual bytes');
    const captured = JSON.parse(await run('capture'));
    expect(captured).toEqual(['artifact', 'base64.py', 'json.py'].map(path => ({
      path, data: Buffer.from(path === 'artifact' ? 'actual bytes' : poison).toString('base64'), executable: false,
    })));
    const invocation = calls.find(call => call.argv.includes(FILE_HELPER_PATH))!;
    expect(invocation.argv.slice(invocation.argv.indexOf('--') + 1, invocation.argv.indexOf('--') + 4)).toEqual(['python3', '-I', FILE_HELPER_PATH]);
    expect(invocation.argv[invocation.argv.indexOf('--chdir') + 1]).toBe('/');
    expect(invocation.argv).not.toContain('-c');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('writes and reads the 16 MiB maximum through real exec without transporting content in argv', async () => {
  const {directory, root, control, calls, run} = await fixture();
  try {
    const bytes = Buffer.alloc(SNAPSHOT_MAX_BYTES);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    await run('write', 'nested/result.bin', bytes);
    expect((await readFile(join(root, 'nested/result.bin'))).equals(bytes)).toBe(true);
    expect(Buffer.from(await run('read', 'nested/result.bin'), 'base64').equals(bytes)).toBe(true);
    expect(calls.every(call => call.argv.every(arg => arg.length < 4096))).toBe(true);
    expect(await readdir(control)).toEqual([]);
    await expect(run('write', 'too-large', Buffer.alloc(SNAPSHOT_MAX_BYTES + 1))).rejects.toThrow('size limit');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}, 30_000);

it('removes staged helper/input files after a failed exec and refuses staging inside child data', async () => {
  const {directory, root, control, port, run} = await fixture();
  try {
    await symlink(directory, join(root, 'outside'));
    await expect(run('write', 'outside/escape', Buffer.from('test'))).rejects.toThrow();
    expect(await readdir(control)).toEqual([]);
    await expect(fileOperation(port, root, root, 'write', 'file', new Uint8Array(), root)).rejects.toThrow('outside');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('built-in Python diagnostics cannot be replaced by a workspace py_compile.py', async () => {
  const {directory, root} = await fixture();
  try {
    await writeFile(join(root, 'py_compile.py'), 'import os; os._exit(0)');
    const source = 'def broken(:\n';
    await writeFile(join(root, 'broken.py'), source);
    const report = await runDiagnostics(localSandboxPort(join(directory, 'jobs')), root, 'broken.py', source, {trustedConfigs: new Set()});
    expect(report.ok).toBe(false);
    expect(report.problems.some(problem => problem.check === 'python-syntax')).toBe(true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
