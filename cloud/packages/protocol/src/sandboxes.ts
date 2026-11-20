import {z} from 'zod';

// Sandbox lifecycle RPC between the turn worker and Convex (PRA-52); both boundaries parse these shapes.

/** One sandbox and one Volume per owner and scope; PRA-82 adds a coding scope beside the v1 workspace. */
export const SandboxScopeSchema = z.enum(['workspace']);
export type SandboxScope = z.infer<typeof SandboxScopeSchema>;

export const SANDBOX_FUNCTIONS = {
  claim: 'sandboxes:claim',
  commit: 'sandboxes:commit',
  release: 'sandboxes:release',
} as const;

export const SANDBOX_LIFECYCLE = {
  /** A booting row is the lock; a holder that has not committed by then is presumed dead and fenced out. */
  BOOT_LEASE_MS: 180_000,
  /** How long a caller that lost the boot race waits before claiming again. */
  WAIT_POLL_MS: 500,
  /** A ready row this close to Modal's hard lifetime is replaced rather than reused mid-call. */
  EXPIRY_MARGIN_MS: 60_000,
} as const;

/** Random, so Modal never sees an owner id (TenantId is PRA-36's job); the row keeps it for reuse and deletion. */
export const SandboxVolumeNameSchema = z.string().regex(/^praxis-[a-z]+-[a-f0-9]{32}$/);
const Generation = z.number().int().positive();
const Slot = z.number().int().positive();
const SandboxId = z.string().min(1).max(200);
const EpochMs = z.number().int().positive();

export const SandboxClaimRequestSchema = z.object({
  scope: SandboxScopeSchema,
  /** Only read when the owner has no row yet; an existing row's slot and Volume always win. */
  placement: z.object({slot: Slot, volumeName: SandboxVolumeNameSchema}).optional(),
});
export type SandboxClaimRequest = z.infer<typeof SandboxClaimRequestSchema>;

/** The writer the new boot replaces; it must be confirmed gone before the Volume is mounted again. */
export const SandboxPreviousSchema = z.object({generation: Generation, sandboxId: SandboxId.optional()});

export const SandboxClaimSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('ready'), generation: Generation, slot: Slot, sandboxId: SandboxId}),
  z.object({kind: z.literal('boot'), generation: Generation, slot: Slot, volumeName: SandboxVolumeNameSchema,
    previous: SandboxPreviousSchema.optional()}),
  z.object({kind: z.literal('wait'), retryAfterMs: z.number().int().positive()}),
  /** No row yet: the caller places the owner and claims again; `slot` is set when another scope already chose one. */
  z.object({kind: z.literal('unplaced'), slot: Slot.optional()}),
]);
export type SandboxClaim = z.infer<typeof SandboxClaimSchema>;

export const SandboxCommitRequestSchema = z.object({
  scope: SandboxScopeSchema, generation: Generation, sandboxId: SandboxId, expiresAtMs: EpochMs,
});
export type SandboxCommitRequest = z.infer<typeof SandboxCommitRequestSchema>;

export const SandboxReleaseRequestSchema = z.object({scope: SandboxScopeSchema, generation: Generation});
export type SandboxReleaseRequest = z.infer<typeof SandboxReleaseRequestSchema>;

/** Whether the compare-and-set on `generation` applied; false means another writer fenced this one out. */
export const SandboxFenceResultSchema = z.object({applied: z.boolean()});
export type SandboxFenceResult = z.infer<typeof SandboxFenceResultSchema>;
