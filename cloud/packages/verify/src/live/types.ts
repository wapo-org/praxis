import type {CredentialPool} from '@praxis/credentials';
import type {SealedSecret} from '@praxis/types';

/** Everything a step reads from the environment; a step whose needs are not met is skipped, never passed. */
export interface StepNeeds {
  /** Key material: read as `SealedSecret` and seeded into the redactor. */
  secrets?: readonly string[];
  /** Non-secret settings such as base URLs and project ids. */
  config?: readonly string[];
  /** `@praxis/credentials` pools, read with the same `NAME`, `NAME_2`… rules as production. */
  pools?: readonly {name: string; service: string; minSlots: number}[];
}

export interface StepContext {
  secret(name: string): SealedSecret;
  config(name: string): string;
  pool(name: string): CredentialPool;
  /** Every line passes through the redactor before it is stored. */
  log(line: string): void;
  /** Stores evidence next to proof.json, redacted if text, and records its sha256. */
  attach(name: string, content: string | Uint8Array): void;
  /** Hand-off between steps of one run, e.g. a run id the next step inspects. */
  state: Map<string, string>;
}

export interface StepOutcome {
  status: 'pass' | 'fail';
  summary: string;
}

interface StepBase {
  id: string;
  /** The checklist line of the live-check issue this step proves, quoted so the proof reads against it. */
  checklist: string;
  needs: StepNeeds;
}

export interface AutoStep extends StepBase {
  kind: 'auto';
  /** Releases resources allocated by earlier steps, even on partial runs. */
  cleanup?: true;
  run(context: StepContext): Promise<StepOutcome>;
}

export interface ManualStep extends StepBase {
  kind: 'manual';
  instruction: string;
  /** What the human attaches with `--evidence <step>=<path|url>`. */
  evidence: 'file' | 'url';
}

export type LiveStep = AutoStep | ManualStep;

export interface LiveSuite {
  /** Equals the file name in `cloud/verify/live/`. */
  id: string;
  /** The `Live check: PRA-n` issue this suite closes. */
  issue: string;
  title: string;
  steps: readonly LiveStep[];
}

/** Identity function that gives suite files type checking without a class hierarchy. */
export function defineSuite(suite: LiveSuite): LiveSuite {
  return suite;
}
