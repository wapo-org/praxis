import {posix} from 'node:path';
import {z} from 'zod';
import type {HandoffSnapshotPort, SubagentWorkspacePort} from '@praxis/agent';
import {SUBAGENT_WORKSPACE_ROOT, SubagentIdSchema} from '@praxis/protocol';
import {parseTenantId, type TenantId} from '@praxis/types';
import type {ExecRequest, ExecResult, SandboxPort} from './port.js';
import {fail, sha256, withWorkspaceLock} from './support.js';
import {canonicalRoot, checkedExec, fileOperation, isolatedArgv, ISOLATION_TIMEOUT_MS, prepareIsolation, relativePath, SNAPSHOT_FILES_MAX, SNAPSHOT_MAX_BYTES} from './subagent-isolation.js';

const SNAPSHOT_ROOT = '/workspace/.handoffs';
const SNAPSHOT_MANIFEST = 'manifest.json';
const SNAPSHOT_CONTENT = 'content';
const ENCODING = 'base64';
const SnapshotSchema = z.array(z.object({path: z.string(), executable: z.boolean(), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict()).max(SNAPSHOT_FILES_MAX);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface WorkspaceBinding {
  tenantId: TenantId;
  childId: string;
  revision: number;
}

// PRA-58 supplies durable ownership, interrupt/kill and confirmed-death probing for every kind of child handle.
export interface OwnedHandleCleanup {
  terminate(binding: WorkspaceBinding, handle: string): Promise<'dead' | 'absent' | 'uncertain'>;
}

export interface WorkspaceOptions {
  binding: WorkspaceBinding;
  checks: Readonly<Record<string, readonly string[]>>;
  cleanup: OwnedHandleCleanup;
}

function parseSnapshot(raw: string) {
  const files = SnapshotSchema.parse(JSON.parse(raw));
  const paths = new Set<string>();
  let sizeBytes = 0;
  for (const file of files) {
    relativePath(file.path);
    if (paths.has(file.path)) fail('schema', 'Snapshot contains duplicate paths.');
    paths.add(file.path);
    sizeBytes += Buffer.byteLength(file.data, ENCODING);
  }
  if (sizeBytes > SNAPSHOT_MAX_BYTES) fail('budget', 'Snapshot exceeds the size limit.');
  return files;
}

export class SandboxSubagentWorkspace implements SubagentWorkspacePort {
  readonly root: string;
  readonly #binding: WorkspaceBinding;
  readonly #checks: Readonly<Record<string, readonly string[]>>;
  readonly #cleanup: OwnedHandleCleanup;
  #prepared = false;

  constructor(readonly port: SandboxPort, options: WorkspaceOptions) {
    this.#binding = Object.freeze({...options.binding,
      tenantId: parseTenantId(options.binding.tenantId), childId: SubagentIdSchema.parse(options.binding.childId),
      revision: z.number().int().nonnegative().parse(options.binding.revision)});
    this.root = posix.join(SUBAGENT_WORKSPACE_ROOT, this.#binding.childId);
    this.#checks = Object.fromEntries(Object.entries(options.checks).map(([id, argv]) => [id, [...argv]]));
    this.#cleanup = options.cleanup;
  }

  #assert(root: string): void {
    if (root !== this.root) fail('policy-denied', 'Workspace is not bound to this child.');
  }

  #ready(root: string): void {
    this.#assert(root);
    if (!this.#prepared) fail('policy-denied', 'Prepare isolation before accessing the workspace.');
  }

  async prepare(root: string): Promise<void> {
    this.#assert(root);
    await prepareIsolation(this.port, root);
    this.#prepared = true;
  }

  async readArtifact(root: string, path: string): Promise<Uint8Array<ArrayBuffer>> {
    this.#ready(root);
    const data = await fileOperation(this.port, root, root, 'read', relativePath(path));
    const bytes = new Uint8Array(Buffer.from(data, ENCODING));
    if (bytes.length > SNAPSHOT_MAX_BYTES) fail('budget', 'Artifact exceeds the size limit.');
    return bytes;
  }

  async writeFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
    this.#ready(root);
    if (bytes.length > SNAPSHOT_MAX_BYTES) fail('budget', 'File exceeds the workspace size limit.');
    await withWorkspaceLock(this.port, root, () => fileOperation(this.port, root, root, 'write', relativePath(path), Buffer.from(bytes).toString(ENCODING)));
  }

  async exec(root: string, request: ExecRequest): Promise<ExecResult> {
    this.#ready(root);
    if (request.cwd !== root) relativePath(posix.relative(root, request.cwd));
    if (posix.resolve(request.cwd) !== request.cwd) fail('path-traversal', 'Exec cwd must be canonical.');
    if (request.env) fail('policy-denied', 'Child execution cannot inherit environment secrets.');
    await canonicalRoot(this.port, root);
    await canonicalRoot(this.port, request.cwd);
    // Child argv is still subject to PRA-76; confinement does not authorize tool effects.
    return this.port.exec({argv: isolatedArgv(root, root, false, request.argv, request.cwd), cwd: '/', timeoutMs: request.timeoutMs});
  }

  #snapshotDirectory(revision: number, digest: string): string {
    if (revision !== this.#binding.revision) fail('policy-denied', 'Snapshot revision is stale.');
    return posix.join(SNAPSHOT_ROOT, this.#binding.tenantId, this.#binding.childId, String(revision), DigestSchema.parse(digest));
  }

  async createSnapshot(root: string): Promise<string> {
    this.#ready(root);
    return withWorkspaceLock(this.port, root, async () => {
      const raw = await fileOperation(this.port, root, root, 'capture');
      const files = parseSnapshot(raw);
      const digest = sha256(raw);
      const directory = this.#snapshotDirectory(this.#binding.revision, digest);
      await canonicalRoot(this.port, directory);
      for (const file of files) {
        const target = posix.join(directory, SNAPSHOT_CONTENT, file.path);
        await canonicalRoot(this.port, target);
        await this.port.writeFile(target, Buffer.from(file.data, ENCODING));
        await checkedExec(this.port, {argv: ['chmod', file.executable ? '700' : '600', '--', target], cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS});
      }
      const content = posix.join(directory, SNAPSHOT_CONTENT);
      await checkedExec(this.port, {argv: ['mkdir', '-p', '--', content], cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS});
      await this.port.writeFile(posix.join(directory, SNAPSHOT_MANIFEST), Buffer.from(raw));
      return digest;
    });
  }

  async openSnapshot(root: string, revision: number, digest: string): Promise<HandoffSnapshotPort> {
    this.#assert(root);
    const directory = this.#snapshotDirectory(revision, digest);
    const content = posix.join(directory, SNAPSHOT_CONTENT);
    await canonicalRoot(this.port, directory);
    const raw = Buffer.from(await this.port.readFile(posix.join(directory, SNAPSHOT_MANIFEST))).toString();
    if (sha256(raw) !== digest) fail('schema', 'Snapshot manifest hash mismatch.');
    const files = parseSnapshot(raw);
    const validate = async () => {
      const captured = parseSnapshot(await fileOperation(this.port, content, root, 'capture'));
      if (sha256(JSON.stringify(captured)) !== sha256(JSON.stringify(files))) fail('schema', 'Snapshot content changed.');
    };
    await validate();
    return {
      readArtifact: async (requestedRoot, path) => {
        this.#assert(requestedRoot);
        await validate();
        const file = files.find(file => file.path === relativePath(path));
        if (!file) fail('not-found', 'Artifact is absent from the verified snapshot.');
        return new Uint8Array(Buffer.from(file.data, ENCODING));
      },
      verifyChecks: async (requestedRoot, ids) => {
        this.#assert(requestedRoot);
        const results = [];
        for (const id of ids) {
          const argv = Object.hasOwn(this.#checks, id) ? this.#checks[id] : undefined;
          if (!argv?.length) fail('policy-denied', 'Check ID is not configured by the server.');
          const result = await this.port.exec({argv: isolatedArgv(content, root, true, argv), cwd: '/', timeoutMs: ISOLATION_TIMEOUT_MS});
          results.push({id, status: !result.timedOut && result.exitCode === 0 ? 'passed' : 'failed'});
        }
        await validate();
        return results;
      },
    };
  }

  async killHandle(root: string, handle: string): Promise<void> {
    this.#assert(root);
    const result = await this.#cleanup.terminate(this.#binding, handle);
    if (result !== 'dead' && result !== 'absent') fail('upstream', 'Handle termination is unconfirmed; keep cancelling.');
  }
}
