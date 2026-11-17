import {WORKSPACE_ERRORS} from './subagent-constants.js';
import {posix} from 'node:path';
import {ArtifactPathSchema} from '@praxis/protocol';
import type {ExecRequest, ExecResult, SandboxPort} from './port.js';
import {fail} from './support.js';

export const ISOLATION_TIMEOUT_MS = 30_000;
// Capture bounds keep verification memory independent of arbitrary workspace growth.
export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SNAPSHOT_FILES_MAX = 10_000;
const SYSTEM_DIRECTORIES = ['/usr', '/bin', '/lib', '/lib64'];
const PYTHON = 'python3';
const PREPARE_ARGV = ['mkdir', '-p', '--'];
const PROBE_ARGV = ['/usr/bin/true'];

// Namespace mounts exclude parent/sibling workspaces, host credentials, sockets and the host network.
export function isolatedArgv(source: string, root: string, readOnly: boolean, argv: readonly string[], cwd = root): string[] {
  return ['bwrap', '--die-with-parent', '--unshare-all', '--new-session', '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    ...SYSTEM_DIRECTORIES.flatMap(path => ['--ro-bind', path, path]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    readOnly ? '--ro-bind' : '--bind', source, root, '--chdir', cwd, '--', ...argv];
}

// O_NOFOLLOW on every component closes the path-check/open race, including symlinks pointing inside the root.
export const FILE_OPERATION = `import os,sys,json,base64,stat
root,op,path,payload=sys.argv[1:]
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
def open_parent(path,create=False):
    parts=path.split('/')
    if any(p in ('','.','..') for p in parts): raise ValueError('invalid path')
    parent=os.dup(fd)
    for part in parts[:-1]:
        if create:
            try: os.mkdir(part,dir_fd=parent)
            except FileExistsError: pass
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        os.close(parent)
        parent=child
    return parent,parts[-1]
if op in ('read','write'):
    parent,name=open_parent(path,op=='write')
    flags=os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_RDONLY if op=='read' else os.O_WRONLY|os.O_CREAT|os.O_TRUNC)
    f=os.open(name,flags,0o600,dir_fd=parent)
    if not stat.S_ISREG(os.fstat(f).st_mode): raise ValueError('not a regular file')
    with os.fdopen(f,'rb' if op=='read' else 'wb') as stream:
        if op=='read': print(base64.b64encode(stream.read(${SNAPSHOT_MAX_BYTES}+1)).decode())
        else: stream.write(base64.b64decode(payload,validate=True))
else:
    files=[]
    total=0
    def walk(directory,prefix):
        global total
        for name in sorted(os.listdir(directory)):
            info=os.stat(name,dir_fd=directory,follow_symlinks=False)
            relative=prefix+name
            if stat.S_ISDIR(info.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
                try: walk(child,relative+'/')
                finally: os.close(child)
            elif stat.S_ISREG(info.st_mode):
                f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
                mode=os.fstat(f).st_mode
                if not stat.S_ISREG(mode): raise ValueError('not a regular file')
                with os.fdopen(f,'rb') as stream: data=stream.read(${SNAPSHOT_MAX_BYTES}+1)
                total+=len(data)
                if total>${SNAPSHOT_MAX_BYTES} or len(files)>=${SNAPSHOT_FILES_MAX}: raise ValueError('snapshot too large')
                files.append({'path':relative,'data':base64.b64encode(data).decode(),'executable':bool(mode&0o111)})
            else: raise ValueError('symlink or special file')
    walk(fd,'')
    print(json.dumps(files,separators=(',',':')))
`;

export function relativePath(input: string): string {
  const parsed = ArtifactPathSchema.safeParse(input);
  if (!parsed.success) fail('path-traversal', WORKSPACE_ERRORS.CANONICAL_PATH);
  return parsed.data;
}

export async function canonicalRoot(port: SandboxPort, root: string): Promise<void> {
  for (let path = root; ; path = posix.dirname(path)) {
    if (await port.realpath(path) !== path) fail('path-traversal', WORKSPACE_ERRORS.CANONICAL_ROOT);
    if (path === '/') break;
  }
}

export async function checkedExec(port: SandboxPort, request: ExecRequest): Promise<ExecResult> {
  const result = await port.exec(request);
  if (result.timedOut || result.exitCode !== 0) fail('upstream', WORKSPACE_ERRORS.ISOLATION_FAILED);
  return result;
}

export async function prepareIsolation(port: SandboxPort, root: string): Promise<void> {
  await canonicalRoot(port, root);
  await checkedExec(port, {argv: [...PREPARE_ARGV, root], cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS});
  await canonicalRoot(port, root);
  await checkedExec(port, {argv: isolatedArgv(root, root, false, PROBE_ARGV), cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS});
}

export async function fileOperation(port: SandboxPort, source: string, root: string, op: 'read' | 'write' | 'capture', path = '', payload = ''): Promise<string> {
  await canonicalRoot(port, source);
  const result = await checkedExec(port, {
    argv: isolatedArgv(source, root, op !== 'write', [PYTHON, '-c', FILE_OPERATION, root, op, path, payload]),
    cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS,
  });
  return result.stdout.trim();
}
