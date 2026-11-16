import {ArtifactPathSchema, HandoffRecordSchema, SubagentCheckSchema, type HandoffRecord} from '@praxis/protocol';
import {z} from 'zod';
import {argsHash} from '../boundary/receipt.js';
import {workspaceFor} from './permissions.js';

// Adapters must scope every operation to this root and reject symlinks escaping it.
export interface SubagentWorkspacePort {
  prepare(root: string): Promise<void>;
  readArtifact(root: string, relativePath: string): Promise<Uint8Array<ArrayBuffer>>;
  verifyChecks(root: string, checkIds: readonly string[]): Promise<unknown>;
  killHandle(root: string, handle: string): Promise<void>;
}
const proofs = new WeakSet<VerifiedHandoff>();
export class VerifiedHandoff {
  readonly #record: HandoffRecord;
  private constructor(record: HandoffRecord, readonly digest: string) {
    this.#record = structuredClone(record);
  }
  get record(): HandoffRecord {
    return structuredClone(this.#record);
  }
  static async verify(raw: unknown, expected: {id: string; revision: number; requiredChecks: readonly string[]}, port: SubagentWorkspacePort): Promise<VerifiedHandoff | null> {
    const parsed = HandoffRecordSchema.safeParse(raw);
    if (!parsed.success) return null;
    const record = structuredClone(parsed.data);
    if (record.subagent_id !== expected.id || record.revision !== expected.revision || !expected.requiredChecks.length) return null;
    const invalidCheck = record.checks.some(c => c.status !== 'passed' || !expected.requiredChecks.includes(c.id));
    const missingCheck = expected.requiredChecks.some(id => !record.checks.some(c => c.id === id));
    if (invalidCheck || missingCheck) return null;
    const root = workspaceFor(expected.id);
    try {
      const checks = z.array(SubagentCheckSchema).parse(await port.verifyChecks(root, record.checks.map(c => c.id)));
      if (checks.length !== record.checks.length || new Set(checks.map(c => c.id)).size !== checks.length ||
        record.checks.some(c => !checks.some(v => v.id === c.id && v.status === 'passed'))) return null;
      for (const artifact of record.artifacts) {
        const bytes = await port.readArtifact(root, ArtifactPathSchema.parse(artifact.path));
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== artifact.sha256) return null;
      }
      const proof = new VerifiedHandoff(record, await argsHash(record));
      proofs.add(proof);
      return proof;
    } catch {
      return null;
    }
  }
  static valid(proof: VerifiedHandoff | undefined, id: string, revision: number, requiredChecks: readonly string[]): boolean {
    return proof !== undefined && proofs.has(proof) && proof.#record.subagent_id === id && proof.#record.revision === revision &&
      requiredChecks.length > 0 && requiredChecks.every(id => proof.#record.checks.some(c => c.id === id && c.status === 'passed'));
  }
}
