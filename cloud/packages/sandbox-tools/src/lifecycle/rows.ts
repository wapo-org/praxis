import {
  SANDBOX_FUNCTIONS,
  SandboxClaimRequestSchema,
  SandboxClaimSchema,
  SandboxCommitRequestSchema,
  SandboxFenceResultSchema,
  SandboxReleaseRequestSchema,
} from '@praxis/protocol';
import type {SandboxRows} from './ports.js';

/** The server-token RPC the worker already holds; it attaches the token, this adapter supplies the owner. */
export interface ConvexMutations {
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Parses both directions at the Convex boundary. */
export function convexSandboxRows(rpc: ConvexMutations): SandboxRows {
  const fence = async (name: string, userId: string, request: unknown) => {
    return SandboxFenceResultSchema.parse(await rpc.mutation(name, {userId, request})).applied;
  };
  return {
    async claim(userId, request) {
      const reply = await rpc.mutation(SANDBOX_FUNCTIONS.claim, {userId, request: SandboxClaimRequestSchema.parse(request)});
      return SandboxClaimSchema.parse(reply);
    },
    commit: (userId, request) => fence(SANDBOX_FUNCTIONS.commit, userId, SandboxCommitRequestSchema.parse(request)),
    release: (userId, request) => fence(SANDBOX_FUNCTIONS.release, userId, SandboxReleaseRequestSchema.parse(request)),
  };
}
