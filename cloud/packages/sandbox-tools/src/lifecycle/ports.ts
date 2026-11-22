import type {SandboxClaim, SandboxClaimRequest, SandboxCommitRequest, SandboxReleaseRequest} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import type {SandboxPort} from '../port.js';

/** The owner-scoped rows in Convex (`convex/sandboxes.ts`); `userId` comes from verified auth, never from a model. */
export interface SandboxRows {
  claim(userId: string, request: SandboxClaimRequest): Promise<SandboxClaim>;
  /** False when another writer fenced this generation out. */
  commit(userId: string, request: SandboxCommitRequest): Promise<boolean>;
  release(userId: string, request: SandboxReleaseRequest): Promise<boolean>;
}

export interface SandboxSpec {
  /** Unique per Volume and generation, so a crashed booter's sandbox can be found and stopped by name. */
  name: string;
  volumeName: string;
  mountPath: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  cpu: number;
  memoryMiB: number;
  readyTimeoutMs: number;
}

/** A sandbox writer to stop: by id when the row recorded one, otherwise by the name its boot used. */
export interface SandboxWriter {
  name: string;
  sandboxId?: string;
}

/** One Modal account (credential slot); Modal for real, an in-memory fake in tests. */
export interface ModalAccount {
  /** Resolves with the id once the sandbox accepts exec. */
  create(spec: SandboxSpec): Promise<string>;
  /** False once Modal reports the sandbox exited or no longer knows it. */
  running(sandboxId: string): Promise<boolean>;
  /** Resolves only after the writer has exited or never existed, so the Volume is safe to mount again. */
  terminate(writer: SandboxWriter): Promise<void>;
  attach(sandboxId: string): Promise<SandboxPort>;
}

/** One slot of `MODAL_POOL`: the token id and secret, keyed by their env names. */
export type ModalCredential = Readonly<Record<string, SealedSecret>>;

/** Slot numbers go to logs only; owner ids, credentials and Modal error text never do. */
export type SandboxLogEvent =
  | {event: 'sandbox.reuse' | 'sandbox.boot' | 'sandbox.gone' | 'sandbox.fenced'; scope: string; slot: number; generation: number; sandboxId: string}
  | {event: 'sandbox.boot_failed'; scope: string; slot: number; generation: number; error: string}
  | {event: 'sandbox.unavailable'; scope: string; slot: number | null; detail: string; retryAtMs: number | null};
