import {join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CLOUD_DIR, LIVE_SUITES_DIR} from '../constants.js';
import {liveSuiteIds} from '../feature-map.js';
import {artifactDir, newRunId} from '../run-context.js';
import type {Proof} from './proof.js';
import {runSuite} from './runner.js';
import type {LiveSuite} from './types.js';

export async function loadSuite(id: string, directory = LIVE_SUITES_DIR): Promise<LiveSuite> {
  const known = liveSuiteIds(directory);
  if (!known.includes(id)) throw new Error(`Unknown live suite ${id}; known: ${known.join(', ')}`);
  const module = (await import(pathToFileURL(join(directory, `${id}.ts`)).href)) as {default?: LiveSuite};
  const suite = module.default;
  if (!suite || suite.id !== id) throw new Error(`cloud/verify/live/${id}.ts must default-export defineSuite({id: '${id}', …})`);
  const ids = suite.steps.map(step => step.id);
  const duplicate = ids.find((stepId, index) => ids.indexOf(stepId) !== index);
  if (duplicate) throw new Error(`suite ${id} declares step ${duplicate} twice`);
  return suite;
}

/** `--evidence step=path|url`, repeatable; the first `=` splits so URLs keep their own. */
export function parseEvidence(values: readonly string[]): Map<string, string> {
  const evidence = new Map<string, string>();
  for (const value of values) {
    const split = value.indexOf('=');
    if (split <= 0 || split === value.length - 1) throw new Error(`--evidence expects <step>=<path|url>, got ${value}`);
    evidence.set(value.slice(0, split), value.slice(split + 1));
  }
  return evidence;
}

function stepLine(step: Proof['steps'][number]): string {
  const detail = step.summary ?? step.reason ?? '';
  return `${step.status.toUpperCase().padEnd(8)} ${step.id.padEnd(22)} ${detail}${step.status === 'pending' && step.instruction ? `\n         ${step.instruction}` : ''}`;
}

export async function runLive(options: {suite: string; evidence: string[]; only?: string[]; json: boolean}, print: (line: string) => void = line => console.log(line)): Promise<Proof> {
  const suite = await loadSuite(options.suite);
  const runId = newRunId();
  const directory = artifactDir('live', suite.id, runId);
  const {proof, path} = await runSuite(suite, {env: process.env, evidence: parseEvidence(options.evidence), ...(options.only ? {only: options.only} : {}), directory, runId});
  if (options.json) {
    print(JSON.stringify({proof: relative(CLOUD_DIR, path), status: proof.status, summary: proof.summary}));
    return proof;
  }
  print(`${suite.issue} ${suite.title}`);
  for (const step of proof.steps) print(stepLine(step));
  const counts = Object.entries(proof.summary).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`).join(', ');
  print(`live ${suite.id}: ${proof.status} (${counts}); proof in ${relative(CLOUD_DIR, path)}`);
  return proof;
}

export async function listSuites(print: (line: string) => void = line => console.log(line)): Promise<void> {
  for (const id of liveSuiteIds()) {
    const suite = await loadSuite(id);
    const auto = suite.steps.filter(step => step.kind === 'auto').length;
    print(`${id.padEnd(18)} ${suite.issue.padEnd(7)} ${auto} auto, ${suite.steps.length - auto} manual  ${suite.title}`);
  }
}
