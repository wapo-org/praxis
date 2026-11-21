import {join} from 'node:path';
import {CLOUD_DIR, FAILURE_TAIL_LINES} from './constants.js';
import {runCommand, type CommandResult} from './proc.js';
import {artifactDir, newRunId} from './run-context.js';

export interface GateStep {
  id: string;
  command: string;
  args: readonly string[];
}

/** The AGENTS.md "Verification" list, in the order CI reports it; AGENTS.md points here. */
export const GATE_STEPS: readonly GateStep[] = [
  {id: 'typecheck', command: 'npm', args: ['run', 'typecheck']},
  {id: 'test', command: 'npm', args: ['test']},
  {id: 'check-rules', command: 'npm', args: ['run', 'check:rules']},
  {id: 'lint', command: 'npm', args: ['run', 'lint']},
  {id: 'comment-sweep', command: 'node', args: ['scripts/comment-sweep.mjs', 'check']},
  // PR CI never ran `convex deploy`, so a Node import in the default runtime first failed on develop (PRA-169).
  {id: 'convex-bundle', command: 'node', args: ['scripts/convex-bundle.mjs']},
  {id: 'web-build', command: 'npm', args: ['run', 'build', '-w', '@praxis/web']},
  {id: 'api-build', command: 'npm', args: ['run', 'build', '-w', '@praxis/api']},
];

export interface GateStepResult {
  id: string;
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  log: string;
}

export interface GateReport {
  type: 'verify.gate';
  runId: string;
  ok: boolean;
  steps: GateStepResult[];
}

export function selectSteps(only: readonly string[] | undefined, steps: readonly GateStep[] = GATE_STEPS): GateStep[] {
  if (!only?.length) return [...steps];
  const unknown = only.filter(id => !steps.some(step => step.id === id));
  if (unknown.length) throw new Error(`Unknown gate step ${unknown.join(', ')}; known: ${steps.map(step => step.id).join(', ')}`);
  return steps.filter(step => only.includes(step.id));
}

export function formatStepLine(result: Pick<GateStepResult, 'id' | 'ok' | 'ms' | 'code'>): string {
  const seconds = `${(result.ms / 1000).toFixed(1)}s`.padStart(7);
  const line = `${result.ok ? 'PASS' : 'FAIL'} ${result.id.padEnd(14)} ${seconds}`;
  return result.ok ? line : `${line}  exit ${result.code}`;
}

export function tail(output: string, lines = FAILURE_TAIL_LINES): string {
  return output.trimEnd().split('\n').slice(-lines).join('\n');
}

export type StepRunner = (step: GateStep, logFile: string) => Promise<CommandResult>;

const runStep: StepRunner = (step, logFile) => runCommand(step.command, step.args, {cwd: CLOUD_DIR, logFile});

/** Runs every step even after a failure, so one run reports the whole gate. */
export async function runGate(options: {only?: string[]; json?: boolean; runner?: StepRunner; print?: (line: string) => void}): Promise<GateReport> {
  const print = options.print ?? (line => console.log(line));
  const runId = newRunId();
  const directory = artifactDir('gate', runId);
  const steps: GateStepResult[] = [];
  for (const step of selectSteps(options.only)) {
    const log = join(directory, `${step.id}.log`);
    const result = await (options.runner ?? runStep)(step, log);
    const entry = {id: step.id, command: [step.command, ...step.args].join(' '), ok: result.code === 0, code: result.code, ms: result.ms, log};
    steps.push(entry);
    if (options.json) continue;
    print(formatStepLine(entry));
    if (!entry.ok) print(tail(result.output).replace(/^/gm, '    | '));
  }
  const report: GateReport = {type: 'verify.gate', runId, ok: steps.every(step => step.ok), steps};
  if (options.json) print(JSON.stringify(report));
  else print(`${report.ok ? 'gate: ok' : 'gate: FAILED'} (${steps.filter(step => step.ok).length}/${steps.length} steps, logs in ${directory})`);
  return report;
}
