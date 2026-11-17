import {expect, it} from 'vitest';
import fc from 'fast-check';
import {VerifiedHandoff} from '@praxis/agent';
import {parseTenantId} from '@praxis/types';
import {FakeSandboxPort} from './fake.js';
import {SandboxSubagentWorkspace} from './subagent-workspace.js';
import {FILE_OPERATION, isolatedArgv, relativePath} from './subagent-isolation.js';
import {sha256} from './support.js';

const root = '/workspace/.agents/child';
const tenantId = parseTenantId(`tn_${'a'.repeat(64)}`);
const binding = {tenantId, childId: 'child', revision: 0};
const artifact = Buffer.from('verified');
const manifest = JSON.stringify([{path: 'result.txt', data: artifact.toString('base64'), executable: false}]);
function fixture() {
  let terminateResult: 'dead' | 'absent' | 'uncertain' = 'dead';
  let kills = 0;
  const port = new FakeSandboxPort().writeText(`${root}/result.txt`, 'verified');
  port.on(request => {
    if (['mkdir', 'chmod'].includes(request.argv[0]!)) return {exitCode: 0};
    if (request.argv[0] !== 'bwrap') return undefined;
    const script = request.argv.indexOf(FILE_OPERATION);
    if (script !== -1) {
      const [, op, path, payload] = request.argv.slice(script + 1);
      const mount = request.argv.indexOf('--ro-bind', request.argv.indexOf('--tmpfs'));
      const source = mount === -1 ? root : request.argv[mount + 1]!;
      if (op === 'capture') {
        const prefix = `${source}/`;
        const files = [...port.files.entries()].filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => ({path: path.slice(prefix.length), data: Buffer.from(bytes).toString('base64'), executable: false}))
          .sort((a, b) => a.path.localeCompare(b.path));
        return {exitCode: 0, stdout: JSON.stringify(files)};
      }
      if (op === 'read') return {exitCode: 0, stdout: Buffer.from(port.files.get(`${root}/${path}`)!).toString('base64')};
      port.files.set(`${root}/${path}`, Buffer.from(payload!, 'base64'));
    }
    return {exitCode: 0};
  });
  const workspace = new SandboxSubagentWorkspace(port, {binding, checks: {typecheck: ['tsc', '--noEmit']},
    cleanup: {terminate: async () => {kills++; return terminateResult;}}});
  return {port, workspace, kills: () => kills, uncertain: () => {terminateResult = 'uncertain';}};
}

it('requires preparation, isolates before launch, and binds root/revision', async () => {
  const {workspace, port} = fixture();
  await expect(workspace.writeFile(root, 'x', artifact)).rejects.toThrow('Prepare');
  await expect(workspace.prepare('/workspace/.agents/sibling')).rejects.toThrow('bound');
  await workspace.prepare(root);
  expect(port.calls.at(-1)!.argv).toEqual(isolatedArgv(root, root, false, ['/usr/bin/true']));
  await workspace.writeFile(root, 'nested/result', artifact);
  expect(port.readText(`${root}/nested/result`)).toBe('verified');
  await expect(workspace.openSnapshot(root, 1, sha256(manifest))).rejects.toThrow('stale');
});

it('fails closed when namespace preparation is unavailable', async () => {
  const port = new FakeSandboxPort();
  const workspace = new SandboxSubagentWorkspace(port, {binding, checks: {}, cleanup: {terminate: async () => 'dead'}});
  await expect(workspace.prepare(root)).rejects.toThrow('failed');
  await expect(workspace.exec(root, {argv: ['true'], cwd: root, timeoutMs: 100})).rejects.toThrow('Prepare');
});

it.each(['/workspace', '/workspace/.agents', root])('rejects symlink ancestor %s', async path => {
  const {workspace, port} = fixture();
  port.link(path, '/outside');
  await expect(workspace.prepare(root)).rejects.toThrow('symlink');
});

it('confines exec argv, cwd, environment and network independently of shell contents', async () => {
  const {workspace, port} = fixture();
  await workspace.prepare(root);
  const request = {argv: ['sh', '-c', 'cd /; cat /workspace/.agents/sibling/secret'], cwd: root, timeoutMs: 100};
  await workspace.exec(root, request);
  const argv = port.calls.at(-1)!.argv;
  expect(argv).toContain('--unshare-all');
  expect(argv).toContain('--clearenv');
  expect(argv).toEqual(isolatedArgv(root, root, false, request.argv));
  await expect(workspace.exec(root, {...request, cwd: '/workspace/.agents/sibling'})).rejects.toThrow();
  await expect(workspace.exec(root, {...request, env: {TOKEN: 'example'}})).rejects.toThrow('secrets');
  port.link(`${root}/linked`, `${root}/other`);
  await expect(workspace.exec(root, {...request, cwd: `${root}/linked`})).rejects.toThrow('symlink');
});

it('verifies immutable content after live mutation and rejects changed/missing stored snapshots', async () => {
  const {workspace, port} = fixture();
  await workspace.prepare(root);
  const digest = await workspace.createSnapshot(root);
  expect(digest).toBe(sha256(manifest));
  port.writeText(`${root}/result.txt`, 'mutated live workspace');
  const record = {subagent_id: 'child', revision: 0, status: 'completed', snapshot_sha256: digest,
    artifacts: [{path: 'result.txt', sha256: sha256(artifact)}], checks: [{id: 'typecheck', status: 'passed'}], diff_summary: 'result'};
  const expected = {id: 'child', revision: 0, requiredChecks: ['typecheck']};
  expect(await VerifiedHandoff.verify(record, expected, workspace)).not.toBeNull();
  const view = await workspace.openSnapshot(root, 0, digest);
  await expect(view.verifyChecks(root, ['unknown'])).rejects.toThrow('configured');
  await expect(view.readArtifact('/workspace/.agents/sibling', 'result.txt')).rejects.toThrow('bound');
  const stored = [...port.files.keys()].find(path => path.endsWith('/content/result.txt'))!;
  port.writeText(stored, 'tampered');
  expect(await VerifiedHandoff.verify(record, expected, workspace)).toBeNull();
  port.files.delete(stored);
  expect(await VerifiedHandoff.verify(record, expected, workspace)).toBeNull();
});

it('detects snapshot mutation during checks and rejects a forged manifest', async () => {
  const {workspace, port} = fixture();
  await workspace.prepare(root);
  const digest = await workspace.createSnapshot(root);
  const view = await workspace.openSnapshot(root, 0, digest);
  const original = port.exec.bind(port);
  port.exec = async request => {
    const result = await original(request);
    if (request.argv.includes('tsc')) {
      const target = [...port.files.keys()].find(path => path.endsWith('/content/result.txt'))!;
      port.writeText(target, 'changed during check');
    }
    return result;
  };
  await expect(view.verifyChecks(root, ['typecheck'])).rejects.toThrow('changed');
  const path = [...port.files.keys()].find(path => path.endsWith('/manifest.json'))!;
  port.writeText(path, '[]');
  await expect(workspace.openSnapshot(root, 0, digest)).rejects.toThrow('hash mismatch');
});

it('forwards only bound cleanup, and never acknowledges uncertain death', async () => {
  const {workspace, uncertain, kills} = fixture();
  await expect(workspace.killHandle('/workspace/.agents/sibling', 'handle')).rejects.toThrow('bound');
  expect(kills()).toBe(0);
  uncertain();
  await expect(workspace.killHandle(root, 'handle')).rejects.toThrow('unconfirmed');
});

it('rejects generated lexical escape attempts before any file or process operation', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.stringMatching(/^[a-z]{1,12}$/), {minLength: 1, maxLength: 10}), async parts => {
    const {workspace, port} = fixture();
    await workspace.prepare(root);
    const before = port.calls.length;
    const tail = parts.join('/');
    for (const path of [`../${tail}`, `/${tail}`, `${tail}/../../escape`, `${tail}//file`, `${tail}/./file`, `${tail}/%2e%2e`, `${tail}\\escape`, `${tail}\0`]) {
      await expect(workspace.writeFile(root, path, artifact)).rejects.toThrow();
      await expect(workspace.readArtifact(root, path)).rejects.toThrow();
    }
    expect(port.calls.length).toBe(before);
    expect(relativePath(tail)).toBe(tail);
  }), {numRuns: 500});
});

it('cleanup retries use confirmed absence and cancelled redelivery invokes no cleanup', async () => {
  const {cleanupSubagent, reduceSubagents, createSubagentTree} = await import('@praxis/agent');
  const {port} = fixture();
  let calls = 0;
  let terminated = false;
  const workspace = new SandboxSubagentWorkspace(port, {binding, checks: {}, cleanup: {terminate: async () => {
    calls++;
    if (calls === 1) throw new Error('uncertain transport');
    if (terminated) return 'absent';
    terminated = true;
    return 'dead';
  }}});
  let tree = createSubagentTree('root', {tools: ['spawn_agent'], max_depth: 1, turn_cap: 3,
    visibility_depth: 1, discover_siblings: false, required_checks: ['typecheck']}, 'model');
  tree = reduceSubagents(tree, {type: 'spawn', actorId: 'root', id: 'child', callId: 'spawn', request: {
    action: 'create', prompt: 'task', tools: [], visibility_depth: 0, discover_siblings: false, turn_cap: 3,
  }});
  tree = reduceSubagents(tree, {type: 'handle', id: 'child', handle: 'owned-process'});
  tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'child'});
  await expect(cleanupSubagent(tree, 'child', workspace)).rejects.toThrow('uncertain transport');
  expect(tree.nodes.find(node => node.id === 'child')).toMatchObject({status: 'cancelling', handles: ['owned-process']});
  const cancelled = await cleanupSubagent(tree, 'child', workspace);
  expect(await cleanupSubagent(cancelled, 'child', workspace)).toBe(cancelled);
  expect(calls).toBe(2);
  await workspace.killHandle(root, 'owned-process');
  expect(calls).toBe(3);
});
