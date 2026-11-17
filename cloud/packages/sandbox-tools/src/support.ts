import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {ToolBoundaryError, toolError} from '@praxis/agent';
import type {ToolErrorCode} from '@praxis/protocol';
import {OUTPUT_MAX_BYTES, PRAXIS_DIR} from './constants.js';
import type {SandboxPort} from './port.js';

/** Every failure leaves through PRA-76's ToolError, so the model always gets a remediation line. */
export function fail(code: ToolErrorCode, message: string): never {
  throw new ToolBoundaryError(toolError(code, message));
}

/** Model-supplied paths resolve inside the chat directory; `..` and absolute paths outside it are refused. */
export function resolveInside(root: string, input: string): string {
  if (!input || input.includes('\0')) fail('schema', 'Path is empty or contains a NUL byte.');
  const resolved = posix.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) fail('path-traversal', `${input} is outside ${root}.`);
  return resolved;
}

/** Lexical containment, then the real target: a symlink inside the chat directory cannot point the tools outside it. */
export async function containedPath(port: SandboxPort, root: string, input: string): Promise<{path: string; root: string}> {
  const lexical = resolveInside(root, input);
  const [real, realRoot] = await Promise.all([port.realpath(lexical), port.realpath(root)]);
  if (real !== realRoot && !real.startsWith(`${realRoot}/`)) fail('path-traversal', `${input} resolves through a symlink to ${real}, outside ${root}.`);
  return {path: real, root: realRoot};
}

const workspaceLocks = new WeakMap<SandboxPort, Map<string, Promise<unknown>>>();

/** Workspace mutations and checkpoints share a queue, so staging cannot observe a partial edit. */
async function withLock<T>(pool: WeakMap<SandboxPort, Map<string, Promise<unknown>>>, port: SandboxPort, path: string, work: () => Promise<T>): Promise<T> {
  const held = pool.get(port) ?? new Map<string, Promise<unknown>>();
  pool.set(port, held);
  const previous = held.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  held.set(path, settled);
  try {
    return await next;
  } finally {
    if (held.get(path) === settled) held.delete(path);
  }
}

/** The tools' own bookkeeping is off limits to edit_file and export_file. */
export function assertNotInternal(root: string, path: string): void {
  const internal = posix.join(root, PRAXIS_DIR);
  if (path === internal || path.startsWith(`${internal}/`)) fail('policy-denied', `${PRAXIS_DIR}/ is managed by the sandbox tools.`);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Capped {
  text: string;
  truncated: boolean;
}

/** Keeps the head and the tail (errors usually sit at the end) and says how much was dropped. */
export function capOutput(text: string, maxBytes = OUTPUT_MAX_BYTES): Capped {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return {text, truncated: false};
  const half = Math.floor(maxBytes / 2);
  const dropped = bytes.length - 2 * half;
  const head = bytes.subarray(0, half).toString('utf8');
  const tail = bytes.subarray(bytes.length - half).toString('utf8');
  return {text: `${head}\n… ${dropped} bytes omitted …\n${tail}`, truncated: true};
}

/** Strips terminal colour and cursor sequences so the model sees plain text. */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

/** A checkpoint must see a complete workspace mutation, including all writes before diagnostics finish. */
export async function withWorkspaceLock<T>(port: SandboxPort, root: string, work: () => Promise<T>): Promise<T> {
  return withLock(workspaceLocks, port, await port.realpath(root), work);
}
