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

/** Takes the boot lock with a fresh generation; the old writer is reported so the caller confirms it gone. */
async function takeBoot(ctx: MutationCtx, row: SandboxRow, now: number): Promise<SandboxClaim> {
  const generation = row.generation + 1;
  await ctx.db.patch(row._id, {
    generation,
    state: {status: 'booting', leaseExpiresAt: now + SANDBOX_LIFECYCLE.BOOT_LEASE_MS},
    lastUsedAt: now,
  });
  return {kind: 'boot', generation, slot: row.slot, volumeName: row.volumeName, previous: previousWriter(row)};
}

async function claimExisting(ctx: MutationCtx, row: SandboxRow, now: number): Promise<SandboxClaim> {
  const state = row.state;
  switch (state.status) {
    case 'ready': {
      if (state.expiresAt - SANDBOX_LIFECYCLE.EXPIRY_MARGIN_MS <= now) return takeBoot(ctx, row, now);
      await ctx.db.patch(row._id, {lastUsedAt: now});
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

/** Reuse a ready sandbox, or win the boot lock; a mutation is serializable, so exactly one caller boots. */
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
    await ctx.db.insert('sandboxes', {
      userId: args.userId,
      scope,
      slot,
      volumeName: placement.volumeName,
      generation,
      state: {status: 'booting', leaseExpiresAt: now + SANDBOX_LIFECYCLE.BOOT_LEASE_MS},
      lastUsedAt: now,
    });
    return {kind: 'boot', generation, slot, volumeName: placement.volumeName};
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

/** Marks the caller's generation terminated after a failed boot or a sandbox Modal no longer runs. */
export const release = serverMutation({
  args: {request: convexValidator(SandboxReleaseRequestSchema)},
  handler: async (ctx, args): Promise<SandboxFenceResult> => {
    const request = SandboxReleaseRequestSchema.parse(args.request);
    const row = await rowFor(ctx, args.userId, request.scope);
    if (!row || row.generation !== request.generation || row.state.status === 'terminated') return {applied: false};
    const sandboxId = row.state.status === 'ready' ? row.state.sandboxId : undefined;
    await ctx.db.patch(row._id, {
      state: sandboxId === undefined ? {status: 'terminated'} : {status: 'terminated', sandboxId},
    });
    return {applied: true};
  },
});
