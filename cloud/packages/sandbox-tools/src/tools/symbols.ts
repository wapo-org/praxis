import {ToolBoundaryError, toolError} from '@praxis/agent';
import {posix} from 'node:path';
import {z} from 'zod';
import {runDiagnostics} from '../diagnostics.js';
import {assertNotInternal, containedPath, fail, sha256, withFileLock, withWorkspaceLock} from '../support.js';
import {SYMBOL_CANDIDATES_MAX, SYMBOL_GRAMMARS, SYMBOL_UNSUPPORTED} from '../symbols/constants.js';
import {symbolRanges, type SymbolRange} from '../symbols/parser.js';
import type {SandboxToolContext} from './context.js';
import {readText} from './files.js';

export const ReplaceSymbolInputSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1),
  new_text: z.string(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

function candidates(ranges: SymbolRange[]): string {
  const listed = ranges.slice(0, SYMBOL_CANDIDATES_MAX).map(range => `${range.qualified} (line ${range.line})`);
  return `${listed.join(', ') || '(none)'}${ranges.length > SYMBOL_CANDIDATES_MAX ? ', …' : ''}`;
}

async function replaceSymbolLocked(context: SandboxToolContext, raw: unknown) {
  const input = ReplaceSymbolInputSchema.parse(raw);
  const {path, root} = await containedPath(context.port, context.root, input.path);
  assertNotInternal(root, path);
  const extension = posix.extname(path).toLowerCase();
  const grammar = SYMBOL_GRAMMARS[extension as keyof typeof SYMBOL_GRAMMARS];
  if (!grammar) throw new ToolBoundaryError({...toolError('schema', SYMBOL_UNSUPPORTED), remediation: SYMBOL_UNSUPPORTED});
  const written = await withFileLock(context.port, path, async () => {
    const {bytes} = await readText(context, path);
    if (input.expected_sha256 && input.expected_sha256 !== sha256(bytes)) fail('conflict', `${path} changed since it was read.`);
    // Buffer preserves a UTF-8 BOM; decoding and re-encoding untouched text must preserve every byte.
    const text = Buffer.from(bytes).toString('utf8');
    const ranges = await symbolRanges(text, grammar);
    const matches = ranges.filter(range => input.symbol.includes('.') ? range.qualified === input.symbol : range.name === input.symbol);
    if (matches.length === 0) fail('not-found', `${input.symbol} was not found. Candidates: ${candidates(ranges)}.`);
    if (matches.length > 1) fail('conflict', `${input.symbol} is ambiguous. Candidates: ${candidates(matches)}.`);
    const match = matches[0]!;
    return {next: text.slice(0, match.start) + input.new_text + text.slice(match.end), symbol: match.qualified};
  }, async edit => {
    const bytes = new TextEncoder().encode(edit.next);
    await context.port.writeFile(path, bytes);
    return {...edit, bytes};
  });
  const diagnostics = await runDiagnostics(context.port, root, posix.relative(root, path), written.next, {
    trustedConfigs: context.trustedDiagnostics ?? new Set(), ...(context.now ? {now: context.now} : {}),
  });
  return {path, symbol: written.symbol, sha256: sha256(written.bytes), replacements: 1, created: false, diagnostics};
}

export async function replaceSymbol(context: SandboxToolContext, raw: unknown) {
  return withWorkspaceLock(context.port, context.root, () => replaceSymbolLocked(context, raw));
}
