import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {ToolBoundaryError, toolError} from '@praxis/agent';
import type {ToolErrorCode} from '@praxis/protocol';
import {OUTPUT_MAX_BYTES, PRAXIS_DIR} from './constants.js';

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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, 'g');

/** Strips terminal colour and cursor sequences so the model sees plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}
