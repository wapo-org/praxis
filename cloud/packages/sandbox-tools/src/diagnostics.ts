import {posix} from 'node:path';
import {z} from 'zod';
import {DIAGNOSTICS_BUDGET_MS, DIAGNOSTICS_CONFIG, DIAGNOSTICS_PROBLEMS_MAX} from './constants.js';
import type {SandboxPort} from './port.js';
import {decodeText, stripAnsi} from './support.js';

/** How a check's output becomes problems; `text` keeps raw lines when nothing better fits. */
export const DiagnosticFormatSchema = z.enum(['tsc', 'gnu', 'node', 'python', 'text']);

export const DiagnosticCheckSchema = z.object({
  name: z.string().min(1).max(40),
  /** Globs relative to the chat directory; `**` crosses directories, `*` does not. */
  files: z.array(z.string().min(1)).min(1),
  /** `{file}` is replaced by the edited file's path relative to the chat directory. */
  argv: z.array(z.string().min(1)).min(1),
  format: DiagnosticFormatSchema.default('gnu'),
  timeoutMs: z.number().int().positive().max(DIAGNOSTICS_BUDGET_MS).optional(),
}).strict();

/** `.praxis/diagnostics.json`: the workspace says which checks follow an edit; absent, built-in syntax checks run. */
export const DiagnosticsConfigSchema = z.object({version: z.literal(1), checks: z.array(DiagnosticCheckSchema).max(10)}).strict();

export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;

export const BUILTIN_CHECKS: readonly DiagnosticCheck[] = [
  {name: 'node-syntax', files: ['**/*.js', '**/*.mjs', '**/*.cjs'], argv: ['node', '--check', '{file}'], format: 'node'},
  {name: 'python-syntax', files: ['**/*.py'], argv: ['python3', '-m', 'py_compile', '{file}'], format: 'python'},
];

export interface Problem {
  check: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  /** `skipped` means the shared budget ran out before the check could start. */
  ran: {check: string; outcome: 'passed' | 'failed' | 'timed-out' | 'skipped'; ms: number}[];
  problems: Problem[];
  truncated: boolean;
}

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Negated classes instead of lazy `.+?`, so a long line without a match fails in linear time.
const TSC_LINE = /^([^(\n]+)\((\d+),(\d+)\): (?:error|warning) (TS\d+: [^\n]*)$/gm;
const GNU_LINE = /^([^:\n]+):(\d+)(?::(\d+))?:[ \t]*([^\n]+)$/gm;
const FILE_LINE = /^([^:\n]+):(\d+)$/m;
const ERROR_LINE = /^(\w*Error: [^\n]*)$/m;
const PYTHON_LOCATION = /File "([^"\n]+)", line (\d+)/;

function located(check: string, location: RegExpExecArray | null, message: string): Problem {
  return {check, ...(location ? {file: location[1]!, line: Number(location[2])} : {}), message};
}

const PARSERS: Record<z.infer<typeof DiagnosticFormatSchema>, (output: string, check: string) => Problem[]> = {
  tsc: (output, check) => [...output.matchAll(TSC_LINE)].map(match => ({
    check,
    file: match[1]!,
    line: Number(match[2]),
    column: Number(match[3]),
    message: match[4]!,
  })),
  gnu: (output, check) => [...output.matchAll(GNU_LINE)].map(match => ({
    check,
    file: match[1]!,
    line: Number(match[2]),
    ...(match[3] ? {column: Number(match[3])} : {}),
    message: match[4]!.trim(),
  })),
  node: (output, check) => {
    const error = ERROR_LINE.exec(output);
    return error ? [located(check, FILE_LINE.exec(output), error[1]!)] : [];
  },
  python: (output, check) => {
    const error = ERROR_LINE.exec(output);
    return error ? [located(check, PYTHON_LOCATION.exec(output), error[1]!)] : [];
  },
  text: (output, check) => output.split('\n').map(line => line.trim()).filter(Boolean).map(message => ({check, message})),
};

async function loadChecks(port: SandboxPort, root: string): Promise<{checks: readonly DiagnosticCheck[]; problems: Problem[]}> {
  const path = posix.join(root, DIAGNOSTICS_CONFIG);
  if (!(await port.stat(path))) return {checks: BUILTIN_CHECKS, problems: []};
  const text = decodeText(await port.readFile(path));
  try {
    return {checks: DiagnosticsConfigSchema.parse(JSON.parse(text ?? '')).checks, problems: []};
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : 'not valid JSON';
    return {checks: [], problems: [{check: 'config', file: DIAGNOSTICS_CONFIG, message: `ignored: ${detail}`}]};
  }
}

function jsonProblems(text: string, file: string): Problem[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    return [{check: 'json-syntax', file, message: error instanceof Error ? error.message : 'invalid JSON'}];
  }
}

/** Runs every check matching the edited file, inside one shared budget, and returns problems instead of throwing. */
export async function runDiagnostics(port: SandboxPort, root: string, relativeFile: string, content: string, now: () => number = Date.now): Promise<DiagnosticsReport> {
  const started = now();
  const {checks, problems} = await loadChecks(port, root);
  const ran: DiagnosticsReport['ran'] = [];
  if (relativeFile.endsWith('.json')) problems.push(...jsonProblems(content, relativeFile));
  for (const check of checks.filter(entry => entry.files.some(glob => globToRegExp(glob).test(relativeFile)))) {
    const remaining = DIAGNOSTICS_BUDGET_MS - (now() - started);
    if (remaining <= 0) {
      ran.push({check: check.name, outcome: 'skipped', ms: 0});
      continue;
    }
    const argv = check.argv.map(word => word.replaceAll('{file}', relativeFile));
    const result = await port.exec({argv, cwd: root, timeoutMs: Math.min(check.timeoutMs ?? remaining, remaining)});
    const outcome = result.timedOut ? 'timed-out' : result.exitCode === 0 ? 'passed' : 'failed';
    ran.push({check: check.name, outcome, ms: result.durationMs});
    if (outcome !== 'failed') continue;
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    const parsed = PARSERS[check.format](output, check.name);
    problems.push(...(parsed.length ? parsed : [{check: check.name, message: output.trim().split('\n').slice(-5).join('\n') || `exit ${result.exitCode}`}]));
  }
  return {
    ok: problems.length === 0 && ran.every(entry => entry.outcome === 'passed'),
    ran,
    problems: problems.slice(0, DIAGNOSTICS_PROBLEMS_MAX),
    truncated: problems.length > DIAGNOSTICS_PROBLEMS_MAX,
  };
}
