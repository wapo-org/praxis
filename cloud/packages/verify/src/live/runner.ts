import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {pool, type CredentialPool} from '@praxis/credentials';
import {SealedSecret} from '@praxis/types';
import {gitState, newRunId} from '../run-context.js';
import {PROOF_SCHEMA, ProofSchema, proofStatus, summarize, type Evidence, type Proof, type ProofStep} from './proof.js';
import {Redactor} from './redact.js';
import type {LiveStep, LiveSuite, StepContext, StepNeeds} from './types.js';

export interface LiveRunOptions {
  env: Record<string, string | undefined>;
  /** `--evidence step=path|url`, for manual steps. */
  evidence: ReadonlyMap<string, string>;
  only?: readonly string[];
  directory: string;
  runId?: string;
  now?: () => Date;
}

const present = (env: LiveRunOptions['env'], name: string) => !!env[name]?.trim();

/** The first unmet need, worded as the skip reason; undefined when the step can run. */
export function missingNeed(needs: StepNeeds, env: LiveRunOptions['env']): string | undefined {
  for (const name of [...(needs.secrets ?? []), ...(needs.config ?? [])]) if (!present(env, name)) return `missing credential ${name}`;
  for (const spec of needs.pools ?? []) {
    let slots: number;
    try {
      slots = pool(spec.name, env, {service: spec.service}).slots.length;
    } catch (error) {
      return `credential pool ${spec.name} is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (slots < spec.minSlots) return `missing credential ${spec.name}${spec.minSlots > 1 ? ` (needs ${spec.minSlots} slots, found ${slots})` : ''}`;
  }
  return undefined;
}

function needNames(needs: StepNeeds): string[] {
  return [...(needs.secrets ?? []), ...(needs.config ?? []), ...(needs.pools ?? []).map(spec => `${spec.name} (pool, ≥${spec.minSlots})`)];
}

/** Seeds every declared secret and pool slot of the whole suite, plus any secret-looking env value. */
export function suiteRedactor(suite: LiveSuite, env: LiveRunOptions['env']): Redactor {
  const redactor = new Redactor().addEnv(env);
  for (const step of suite.steps) {
    for (const name of step.needs.secrets ?? []) if (present(env, name)) redactor.add(env[name]!.trim());
    for (const spec of step.needs.pools ?? []) {
      try {
        for (const slot of pool(spec.name, env, {service: spec.service}).slots) redactor.add(slot.credential);
      } catch {
        // An invalid pool is reported by missingNeed; addEnv already holds its values.
      }
    }
  }
  return redactor;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileEvidence(directory: string, relativePath: string): Evidence {
  const bytes = readFileSync(join(directory, relativePath));
  return {kind: 'file', path: relativePath, sha256: sha256(bytes), bytes: bytes.length};
}

function context(step: LiveStep, options: LiveRunOptions, redactor: Redactor, log: string[], evidence: Evidence[], state: Map<string, string>): StepContext {
  const declared = (name: string, list: readonly string[] | undefined) => {
    if (!list?.includes(name)) throw new Error(`step ${step.id} reads ${name} without declaring it in needs`);
    return options.env[name]!.trim();
  };
  return {
    secret: name => SealedSecret.of(declared(name, step.needs.secrets)),
    config: name => declared(name, step.needs.config),
    pool: (name): CredentialPool => {
      const spec = step.needs.pools?.find(entry => entry.name === name);
      if (!spec) throw new Error(`step ${step.id} reads pool ${name} without declaring it in needs`);
      return pool(spec.name, options.env, {service: spec.service});
    },
    log: line => log.push(redactor.apply(line)),
    attach: (name, content) => {
      const relativePath = join('evidence', `${step.id}-${basename(name)}`);
      mkdirSync(join(options.directory, 'evidence'), {recursive: true});
      writeFileSync(join(options.directory, relativePath), typeof content === 'string' ? redactor.apply(content) : content);
      evidence.push(fileEvidence(options.directory, relativePath));
    },
    state,
  };
}

function manualEvidence(step: LiveStep & {kind: 'manual'}, value: string, options: LiveRunOptions, redactor: Redactor): Evidence {
  if (step.evidence === 'url') {
    const url = new URL(value);
    if (url.username || url.password) throw new Error(`evidence URL for ${step.id} must not carry credentials`);
    return {kind: 'url', url: redactor.apply(url.href)};
  }
  if (!existsSync(value)) throw new Error(`evidence file for ${step.id} not found: ${value}`);
  const relativePath = join('evidence', `${step.id}-${basename(value)}`);
  mkdirSync(join(options.directory, 'evidence'), {recursive: true});
  copyFileSync(value, join(options.directory, relativePath));
  return fileEvidence(options.directory, relativePath);
}

async function runStep(step: LiveStep, options: LiveRunOptions, redactor: Redactor, state: Map<string, string>): Promise<ProofStep> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const log: string[] = [];
  const evidence: Evidence[] = [];
  const base = {id: step.id, kind: step.kind, checklist: step.checklist, needs: needNames(step.needs), evidence, log};
  const finish = (fields: Pick<ProofStep, 'status'> & Partial<ProofStep>): ProofStep => ({...base, startedAt, finishedAt: now().toISOString(), ...fields});
  const missing = missingNeed(step.needs, options.env);
  if (missing) return finish({status: 'skipped', reason: missing});
  if (step.kind === 'manual') {
    const given = options.evidence.get(step.id);
    if (!given) return finish({status: 'pending', instruction: step.instruction, reason: `attach ${step.evidence} evidence with --evidence ${step.id}=<${step.evidence === 'url' ? 'url' : 'path'}>`});
    evidence.push(manualEvidence(step, given, options, redactor));
    return finish({status: 'attached', instruction: step.instruction});
  }
  try {
    const outcome = await step.run(context(step, options, redactor, log, evidence, state));
    return finish({status: outcome.status, summary: redactor.apply(outcome.summary)});
  } catch (error) {
    return finish({status: 'fail', summary: redactor.apply(error instanceof Error ? error.message : String(error))});
  }
}

/** Runs steps in order (later steps may read earlier state) and writes a schema-checked, redacted proof.json. */
export async function runSuite(suite: LiveSuite, options: LiveRunOptions): Promise<{proof: Proof; path: string}> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const unknown = (options.only ?? []).filter(id => !suite.steps.some(step => step.id === id));
  if (unknown.length) throw new Error(`Unknown step ${unknown.join(', ')} in suite ${suite.id}`);
  mkdirSync(options.directory, {recursive: true});
  const redactor = suiteRedactor(suite, options.env);
  const state = new Map<string, string>();
  const steps: ProofStep[] = [];
  for (const step of suite.steps) {
    if (options.only?.length && !options.only.includes(step.id)) continue;
    steps.push(await runStep(step, options, redactor, state));
  }
  const proof = ProofSchema.parse({
    $schema: PROOF_SCHEMA,
    suite: suite.id,
    issue: suite.issue,
    title: suite.title,
    runId: options.runId ?? newRunId(),
    startedAt,
    finishedAt: now().toISOString(),
    git: gitState(),
    host: {platform: process.platform, node: process.version},
    status: proofStatus(steps),
    summary: summarize(steps),
    steps,
  });
  const path = join(options.directory, 'proof.json');
  // Second pass over the serialized proof: a value that slipped past per-field redaction still never lands on disk.
  writeFileSync(path, `${redactor.apply(JSON.stringify(proof, null, 2))}\n`);
  return {proof, path};
}
