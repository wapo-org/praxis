import {
  SANDBOX_LIFECYCLE,
  SandboxClaimRequestSchema,
  SandboxCommitRequestSchema,
  SandboxReleaseRequestSchema,
  type SandboxClaim,
  type SandboxFenceResult,
  type SandboxScope,
} from '@praxis/protocol';
import type {Doc} from './_generated/dataModel.js';
import {serverMutation, type MutationCtx} from './functions.js';
import {admitBoot, settleBoot} from './sandboxSpend.js';
import {convexValidator} from './zodValidator.js';

// Rows are addressed only by the token-vouched owner and a scope; no caller can name a sandbox id to reach one.

type SandboxRow = Doc<'sandboxes'>;

async function rowFor(ctx: MutationCtx, userId: string, scope: SandboxScope): Promise<SandboxRow | null> {
  return ctx.db.query('sandboxes')
    .withIndex('by_user_scope', q => q.eq('userId', userId).eq('scope', scope))
    .unique();
}

/** A user keeps one Modal account across scopes (PRA-99), so a new scope inherits any existing row's slot. */
async function inheritedSlot(ctx: MutationCtx, userId: string): Promise<number | undefined> {
  const any = await ctx.db.query('sandboxes')
    .withIndex('by_user_scope', q => q.eq('userId', userId))
    .first();
  return any?.slot;
}

function previousWriter(row: SandboxRow): {generation: number; sandboxId?: string} {
  const sandboxId = row.state.status === 'booting' ? undefined : row.state.sandboxId;
  return sandboxId === undefined
    ? {generation: row.generation}
    : {generation: row.generation, sandboxId};
}

/** Takes the boot lock with a fresh generation if the free tier admits it; the caller must confirm the old writer gone. */
async function takeBoot(ctx: MutationCtx, row: SandboxRow, now: number): Promise<SandboxClaim> {
  // The writer being replaced is finished either way, so its reservation must not count against the new boot.
  await settleBoot(ctx, row, {now, lastActiveAt: row.lastUsedAt});
  const generation = row.generation + 1;
  const admission = await admitBoot(ctx, {
    userId: row.userId, scope: row.scope, slot: row.slot, volumeName: row.volumeName, generation, now,
  });
  if (admission.kind === 'unavailable') return admission;
  await ctx.db.patch(row._id, {
    generation,
    state: {status: 'booting', leaseExpiresAt: now + SANDBOX_LIFECYCLE.BOOT_LEASE_MS},
    lastUsedAt: now,
    priorUsedAt: undefined,
    reservation: admission.reservation,
  });
  return {
    kind: 'boot', generation, slot: row.slot, volumeName: row.volumeName,
    lifetimeMs: admission.lifetimeMs, previous: previousWriter(row),
  };
}

async function claimExisting(ctx: MutationCtx, row: SandboxRow, now: number): Promise<SandboxClaim> {
  const state = row.state;
  switch (state.status) {
    case 'ready': {
      if (state.expiresAt - SANDBOX_LIFECYCLE.EXPIRY_MARGIN_MS <= now) return takeBoot(ctx, row, now);
      await ctx.db.patch(row._id, {lastUsedAt: now, priorUsedAt: row.lastUsedAt});
      return {kind: 'ready', generation: row.generation, slot: row.slot, sandboxId: state.sandboxId};
    }
    case 'booting': {
      if (state.leaseExpiresAt <= now) return takeBoot(ctx, row, now);
      const retryAfterMs = Math.min(SANDBOX_LIFECYCLE.WAIT_POLL_MS, state.leaseExpiresAt - now);
      return {kind: 'wait', retryAfterMs};
    }
    case 'terminated':
      return takeBoot(ctx, row, now);
  }
}

/** Reuse a ready sandbox, or win the boot lock within the free tier; a mutation is serializable, so exactly one caller boots. */
export const claim = serverMutation({
  args: {request: convexValidator(SandboxClaimRequestSchema)},
  handler: async (ctx, args): Promise<SandboxClaim> => {
    const {scope, placement} = SandboxClaimRequestSchema.parse(args.request);
    const now = Date.now();
    const row = await rowFor(ctx, args.userId, scope);
    if (row) return claimExisting(ctx, row, now);
    const inherited = await inheritedSlot(ctx, args.userId);
    if (!placement) return inherited === undefined ? {kind: 'unplaced'} : {kind: 'unplaced', slot: inherited};
    const slot = inherited ?? placement.slot;
    const generation = 1;
    const admission = await admitBoot(ctx, {
      userId: args.userId, scope, slot, volumeName: placement.volumeName, generation, now,
    });
    if (admission.kind === 'unavailable') return admission;
    await ctx.db.insert('sandboxes', {
      userId: args.userId,
      scope,
      slot,
      volumeName: placement.volumeName,
      generation,
      state: {status: 'booting', leaseExpiresAt: now + SANDBOX_LIFECYCLE.BOOT_LEASE_MS},
      lastUsedAt: now,
      reservation: admission.reservation,
    });
    return {kind: 'boot', generation, slot, volumeName: placement.volumeName, lifetimeMs: admission.lifetimeMs};
  },
});

/** Publishes a booted sandbox only while the caller still holds the boot lock for that generation. */
export const commit = serverMutation({
  args: {request: convexValidator(SandboxCommitRequestSchema)},
  handler: async (ctx, args): Promise<SandboxFenceResult> => {
    const request = SandboxCommitRequestSchema.parse(args.request);
    const row = await rowFor(ctx, args.userId, request.scope);
    if (!row || row.generation !== request.generation || row.state.status !== 'booting') return {applied: false};
    await ctx.db.patch(row._id, {
      state: {status: 'ready', sandboxId: request.sandboxId, expiresAt: request.expiresAtMs},
      lastUsedAt: Date.now(),
    });
    return {applied: true};
  },
});

/** Marks the caller's generation terminated after a failed boot or a sandbox Modal no longer runs, and settles its spend. */
export const release = serverMutation({
  args: {request: convexValidator(SandboxReleaseRequestSchema)},
  handler: async (ctx, args): Promise<SandboxFenceResult> => {
    const request = SandboxReleaseRequestSchema.parse(args.request);
    const row = await rowFor(ctx, args.userId, request.scope);
    if (!row || row.generation !== request.generation || row.state.status === 'terminated') return {applied: false};
    const sandboxId = row.state.status === 'ready' ? row.state.sandboxId : undefined;
    // A ready row is released only by the reuse claim that found it gone, which bumped `lastUsedAt` itself.
    const lastActiveAt = row.state.status === 'ready' ? row.priorUsedAt ?? row.lastUsedAt : row.lastUsedAt;
    await settleBoot(ctx, row, {now: Date.now(), lastActiveAt});
    await ctx.db.patch(row._id, {
      state: sandboxId === undefined ? {status: 'terminated'} : {status: 'terminated', sandboxId},
    });
    return {applied: true};
  },
});
