import {z} from 'zod';

/** Bump on any breaking change: PRA-70's Done guard parses proofs with this schema. */
export const PROOF_SCHEMA = 'praxis-verify/proof@1';

const Timestamp = z.iso.datetime();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const EvidenceSchema = z.discriminatedUnion('kind', [
  /** `path` is relative to the directory holding proof.json. */
  z.object({kind: z.literal('file'), path: z.string().min(1), sha256: Sha256, bytes: z.number().int().nonnegative()}).strict(),
  z.object({kind: z.literal('url'), url: z.string().url()}).strict(),
]);

/** `attached` is manual evidence a human must still judge; packages/verify/README.md defines every status. */
export const StepStatusSchema = z.enum(['pass', 'fail', 'skipped', 'pending', 'attached']);

export const ProofStepSchema = z.object({
  id: z.string(),
  kind: z.enum(['auto', 'manual']),
  checklist: z.string(),
  status: StepStatusSchema,
  summary: z.string().optional(),
  reason: z.string().optional(),
  instruction: z.string().optional(),
  needs: z.array(z.string()),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  evidence: z.array(EvidenceSchema),
  log: z.array(z.string()),
}).strict();

export const ProofSchema = z.object({
  $schema: z.literal(PROOF_SCHEMA),
  suite: z.string(),
  issue: z.string().regex(/^PRA-\d+$/),
  title: z.string(),
  runId: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  git: z.object({sha: z.string(), dirty: z.boolean()}).strict(),
  host: z.object({platform: z.string(), node: z.string()}).strict(),
  /** complete: every step pass or attached. failed: any fail. incomplete: otherwise. */
  status: z.enum(['complete', 'incomplete', 'failed']),
  summary: z.record(StepStatusSchema, z.number().int().nonnegative()),
  steps: z.array(ProofStepSchema),
}).strict();

export type Proof = z.infer<typeof ProofSchema>;
export type ProofStep = z.infer<typeof ProofStepSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

export function proofStatus(steps: readonly Pick<ProofStep, 'status'>[]): Proof['status'] {
  if (steps.some(step => step.status === 'fail')) return 'failed';
  return steps.every(step => step.status === 'pass' || step.status === 'attached') ? 'complete' : 'incomplete';
}

export function summarize(steps: readonly Pick<ProofStep, 'status'>[]): Proof['summary'] {
  const summary: Proof['summary'] = {pass: 0, fail: 0, skipped: 0, pending: 0, attached: 0};
  for (const step of steps) summary[step.status] = (summary[step.status] ?? 0) + 1;
  return summary;
}
