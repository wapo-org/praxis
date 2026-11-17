import {posix} from 'node:path';
import {z} from 'zod';
import {EXPORT_FILE_MAX_BYTES, READ_FILE_LINES_DEFAULT, READ_FILE_MAX_BYTES} from '../constants.js';
import {runDiagnostics, type DiagnosticsReport} from '../diagnostics.js';
import {assertNotInternal, containedPath, decodeText, fail, sha256, withWorkspaceLock} from '../support.js';
import type {SandboxToolContext} from './context.js';

export const ReadFileInputSchema = z.object({
  path: z.string().min(1),
  /** 1-based first line. */
  offset: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(5_000).default(READ_FILE_LINES_DEFAULT),
}).strict();

export const EditFileInputSchema = z.object({
  path: z.string().min(1),
  /** Exact text to replace; empty creates the file, which must not exist yet. */
  old_text: z.string(),
  new_text: z.string(),
  /** From read_file; when given, the edit is refused if the file changed since. */
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  replace_all: z.boolean().default(false),
}).strict();

export const ExportFileInputSchema = z.object({path: z.string().min(1), name: z.string().min(1).max(200).optional()}).strict();

export async function readText(context: SandboxToolContext, path: string): Promise<{text: string; bytes: Uint8Array}> {
  const stat = await context.port.stat(path);
  if (!stat) fail('not-found', `${path} does not exist.`);
  if (stat.type !== 'file') fail('schema', `${path} is a ${stat.type}, not a file.`);
  if (stat.size > READ_FILE_MAX_BYTES) fail('budget', `${path} is ${stat.size} bytes; read_file handles up to ${READ_FILE_MAX_BYTES}. Use shell with head, tail or grep.`);
  const bytes = await context.port.readFile(path);
  const text = decodeText(bytes);
  if (text === undefined) fail('schema', `${path} is binary; use export_file to hand it to the user.`);
  return {text, bytes};
}

export async function readFile(context: SandboxToolContext, raw: unknown) {
  const input = ReadFileInputSchema.parse(raw);
  const {path} = await containedPath(context.port, context.root, input.path);
  const {text, bytes} = await readText(context, path);
  const lines = text.split('\n');
  const first = Math.min(input.offset, lines.length);
  const slice = lines.slice(first - 1, first - 1 + input.limit);
  const width = String(first + slice.length - 1).length;
  return {
    path,
    sha256: sha256(bytes),
    totalLines: lines.length,
    firstLine: first,
    lastLine: first + slice.length - 1,
    content: slice.map((line, index) => `${String(first + index).padStart(width)}\t${line}`).join('\n'),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Exact-match replace, then the workspace's diagnostics; problems come back inline instead of failing the edit. */
async function editFileLocked(context: SandboxToolContext, raw: unknown): Promise<{path: string; sha256: string; replacements: number; created: boolean; diagnostics: DiagnosticsReport}> {
  const input = EditFileInputSchema.parse(raw);
  const {path, root} = await containedPath(context.port, context.root, input.path);
  assertNotInternal(root, path);
  const exists = await context.port.stat(path);
  if (input.old_text === '') {
    if (exists) fail('conflict', `${path} already exists; give old_text to change it.`);
    return {...await completeEdit(context, root, path, input.new_text), replacements: 1, created: true};
  }
  const {text, bytes} = await readText(context, path);
  if (input.expected_sha256 && input.expected_sha256 !== sha256(bytes)) fail('conflict', `${path} changed since it was read.`);
  const replacements = countOccurrences(text, input.old_text);
  if (replacements === 0) fail('conflict', `old_text was not found in ${path}.`);
  if (replacements > 1 && !input.replace_all) fail('conflict', `old_text matches ${replacements} places in ${path}; add surrounding lines or set replace_all.`);
  const next = text.split(input.old_text).join(input.new_text);
  return {...await completeEdit(context, root, path, next), replacements, created: false};
}

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
  '.html': 'text/html', '.zip': 'application/zip', '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/x-python',
};

export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Hands a workspace file to durable storage; the hash lets proofs and the user verify what was exported. */
export async function exportFile(context: SandboxToolContext, raw: unknown, expected?: {sha256: string; bytes: number}) {
  const input = ExportFileInputSchema.parse(raw);
  const {path, root} = await containedPath(context.port, context.root, input.path);
  assertNotInternal(root, path);
  const stat = await context.port.stat(path);
  if (!stat) fail('not-found', `${path} does not exist.`);
  if (stat.type !== 'file') fail('schema', `${path} is a ${stat.type}; export one file (zip a directory with shell first).`);
  if (stat.size > EXPORT_FILE_MAX_BYTES) fail('budget', `${path} is ${stat.size} bytes; exports are capped at ${EXPORT_FILE_MAX_BYTES}.`);
  const bytes = await context.port.readFile(path);
  const name = input.name ?? posix.basename(path);
  const mediaType = mediaTypeFor(name);
  const digest = sha256(bytes);
  if (expected && (digest !== expected.sha256 || bytes.length !== expected.bytes)) fail('conflict', 'Screenshot changed before export.');
  const {ref} = await context.exports.put({name, mediaType, bytes, sha256: digest});
  return {path, name, mediaType, bytes: bytes.length, sha256: digest, ref};
}

export async function editFile(context: SandboxToolContext, raw: unknown) {
  return withWorkspaceLock(context.port, context.root, () => editFileLocked(context, raw));
}

export async function completeEdit(context: SandboxToolContext, root: string, path: string, next: string) {
  const bytes = new TextEncoder().encode(next);
  await context.port.writeFile(path, bytes);
  const diagnostics = await runDiagnostics(context.port, root, posix.relative(root, path), next, {
    trustedConfigs: context.trustedDiagnostics ?? new Set(), ...(context.now ? {now: context.now} : {}),
  });
  return {path, sha256: sha256(bytes), diagnostics};
}
