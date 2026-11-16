#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISABLED_RULES, FILE_LENGTH_MAX, RULES, checkDocFile, checkFile, isSourceFile } from './check-rules-checks.mjs';

const BASELINE_VERSION = 1;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = path.join(DEFAULT_ROOT, 'scripts', 'check-rules.baseline.json');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '_generated']);
const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function isSkipped(file) {
  return file.split('/').some((part) => SKIPPED_DIRECTORIES.has(part) || part.startsWith('.'));
}

function gitFiles(root, extra = []) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', ...extra], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function walkFiles(root, directory = '') {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function listFiles(root) {
  let files;
  try {
    files = gitFiles(root);
  } catch {
    files = walkFiles(root);
  }
  return files.map(toPosix).filter((file) => !isSkipped(file) && existsSync(path.join(root, file)));
}

export function listSourceFiles(root) {
  return listFiles(root).filter(isSourceFile).sort();
}

/** Markdown directly in the repository root, as `../NAME.md`; empty when `root` is not one level inside a git checkout. */
function repoRootDocs(root) {
  try {
    const names = gitFiles(root, ['--full-name', '--', ':(top,glob)*.md']);
    return names.filter((name) => existsSync(path.join(root, '..', name))).map((name) => `../${name}`);
  } catch {
    return [];
  }
}

export function collectViolations(root, enabled = []) {
  const violations = [];
  for (const file of listSourceFiles(root)) {
    violations.push(...checkFile(file, readFileSync(path.join(root, file), 'utf8'), enabled));
  }
  for (const file of [...listFiles(root), ...repoRootDocs(root)].sort()) {
    const violation = checkDocFile(file);
    if (violation) violations.push(violation);
  }
  return violations;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Baseline = per-rule map of path -> violation count, except file length which stores the line count. */
export function buildBaseline(violations) {
  const rules = new Map();
  for (const violation of violations) {
    const paths = rules.get(violation.rule) ?? new Map();
    const value = violation.rule === RULES.fileLength ? violation.lines : (paths.get(violation.path) ?? 0) + 1;
    paths.set(violation.path, value);
    rules.set(violation.rule, paths);
  }
  const sorted = [...rules].map(([rule, paths]) => [rule, sortedObject(paths)]);
  return { version: BASELINE_VERSION, maxFileLines: FILE_LENGTH_MAX, rules: sortedObject(sorted) };
}

export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  if (parsed?.version !== BASELINE_VERSION || typeof parsed.rules !== 'object' || parsed.rules === null) {
    throw new Error(`unsupported baseline (expected version ${BASELINE_VERSION})`);
  }
  for (const [rule, paths] of Object.entries(parsed.rules)) {
    for (const [file, value] of Object.entries(paths)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`bad baseline entry ${rule} ${file}`);
    }
  }
  return parsed;
}

/** New = more hits than baselined for a path+rule (or a longer file); stale = fewer, which may be ratcheted down. */
export function compareToBaseline(violations, baseline) {
  const current = buildBaseline(violations).rules;
  const failures = [];
  const stale = [];

  for (const [rule, paths] of Object.entries(current)) {
    for (const [file, value] of Object.entries(paths)) {
      const allowed = baseline.rules[rule]?.[file] ?? 0;
      if (value <= allowed) continue;
      const hits = violations.filter((violation) => violation.rule === rule && violation.path === file);
      const note = baselineNote(rule, value, allowed);
      failures.push(...hits.map((hit) => ({ ...hit, message: `${hit.message}${note}` })));
    }
  }
  for (const [rule, paths] of Object.entries(baseline.rules)) {
    for (const [file, allowed] of Object.entries(paths)) {
      const value = current[rule]?.[file] ?? 0;
      if (value < allowed) stale.push({ rule, path: file, allowed, value });
    }
  }
  return { failures, stale };
}

function baselineNote(rule, value, allowed) {
  if (allowed === 0) return '';
  if (rule === RULES.fileLength) return ` [grew from baseline ${allowed}]`;
  return ` [${value} in file, baseline allows ${allowed}]`;
}

export function formatViolation(violation) {
  return `${violation.path}:${violation.line} ${violation.rule} ${violation.message}`;
}

export function summarize(violations) {
  const counts = {};
  for (const rule of Object.values(RULES)) counts[rule] = 0;
  for (const violation of violations) counts[violation.rule] += 1;
  return counts;
}

function disabledRule(rule) {
  if (!(rule in DISABLED_RULES)) throw new Error(`--enable takes one of ${Object.keys(DISABLED_RULES).join(', ')}`);
  return rule;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, baseline: null, update: false, all: false, enabled: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--update-baseline') options.update = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--enable') options.enabled.push(disabledRule(argv[(index += 1)]));
    else if (arg === '--root') options.root = path.resolve(argv[(index += 1)] ?? '');
    else if (arg === '--baseline') options.baseline = path.resolve(argv[(index += 1)] ?? '');
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.baseline) {
    const isDefaultRoot = options.root === DEFAULT_ROOT;
    options.baseline = isDefaultRoot ? DEFAULT_BASELINE : path.join(options.root, 'check-rules.baseline.json');
  }
  return options;
}

const USAGE = [
  'usage: node scripts/check-rules.mjs [--update-baseline] [--all] [--enable <rule>] [--root <dir>] [--baseline <file>]',
  '  (default)          fail on violations that are not in the ratchet baseline',
  '  --update-baseline  rewrite the baseline from the current tree (only do this to shrink it)',
  '  --all              list every violation, baselined or not, and exit 0',
  '  --baseline <file>  compare against another baseline, e.g. the base branch copy',
  `  --enable <rule>    also run a rule that is off by default (${Object.keys(DISABLED_RULES).join(', ')})`,
].join('\n');

export function run(argv, write = (line) => console.log(line)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    write(`check-rules: ${error.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const violations = collectViolations(options.root, options.enabled);

  if (options.all) {
    for (const violation of violations) write(formatViolation(violation));
    write(`check-rules: ${violations.length} violation(s) in total ${JSON.stringify(summarize(violations))}`);
    return 0;
  }
  if (options.update) {
    writeFileSync(options.baseline, `${JSON.stringify(buildBaseline(violations), null, 2)}\n`);
    write(`check-rules: baseline rewritten with ${violations.length} violation(s)`);
    return 0;
  }
  if (!existsSync(options.baseline)) {
    write(`check-rules: baseline ${options.baseline} is missing; run with --update-baseline`);
    return EXIT_USAGE;
  }

  const baseline = parseBaseline(readFileSync(options.baseline, 'utf8'));
  const { failures, stale } = compareToBaseline(violations, baseline);
  for (const failure of failures) write(formatViolation(failure));
  if (stale.length > 0) {
    write(`check-rules: ${stale.length} baseline entr(ies) improved; run --update-baseline to lock that in`);
  }
  if (failures.length > 0) {
    write(`check-rules: FAILED with ${failures.length} new violation(s); fix them, do not grow the baseline`);
    return EXIT_VIOLATIONS;
  }
  write(`check-rules: ok (${violations.length} baselined violation(s) remain)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
