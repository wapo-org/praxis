import { getAuthUserId } from '@convex-dev/auth/server';
import { OWNER_ERRORS } from '@praxis/protocol';
import { v, ConvexError, type ObjectType, type PropertyValidators } from 'convex/values';
import { internal } from './_generated/api.js';
import { bounded, requireServer } from './access.js';
import { activeOwner } from './accountOwner.js';
import {
  actionGeneric,
  httpActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  internalActionGeneric,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server';
import type schema from './schema.js';

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;
export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;
export const internalAction: ActionBuilder<DataModel, 'internal'> = internalActionGeneric;
export const httpAction = httpActionGeneric;

/** The wrappers supply the owner; a definition that declared one would let its caller choose it. */
type NoOwnerArgs = { userId?: never; ownerId?: never; serverToken?: never };

const serverArgs = { serverToken: v.string(), userId: v.string() };
type ServerArgs = ObjectType<typeof serverArgs>;

export type OwnedArgs<Args extends PropertyValidators> = ObjectType<Args> & { userId: string };
/** What a server handler sees: the caller's args with `userId` vouched for by the token, minus the token. */
export type ServerOwnedArgs<Args extends PropertyValidators> = Omit<ObjectType<Args> & ServerArgs, 'serverToken'>;

type Definition<Ctx, Args extends PropertyValidators, HandlerArgs, Result> = {
  args: Args & NoOwnerArgs;
  handler: (ctx: Ctx, args: HandlerArgs) => Promise<Result>;
};
type OwnedDefinition<Ctx, Args extends PropertyValidators, Result> = Definition<Ctx, Args, OwnedArgs<Args>, Result>;
type ServerDefinition<Ctx, Args extends PropertyValidators, Result> = Definition<Ctx, Args, ServerOwnedArgs<Args>, Result>;

/** `active` rejects owners whose account deletion has begun; `any` is for reads and the deletion lifecycle itself. */
type OwnerFence = 'active' | 'any';

export const ownerActive = internalQueryGeneric({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => activeOwner(ctx, userId),
});

export async function assertActiveOwner(ctx: AnyCtx, userId: string): Promise<void> {
  const active = 'db' in ctx
    ? await activeOwner(ctx, userId)
    : await ctx.runQuery(internal.functions.ownerActive, { userId });
  if (!active) throw new ConvexError(OWNER_ERRORS.accountUnavailable);
}

/** Action `runQuery` differs from the query one only in its unused options argument. */
type SessionReader = Pick<QueryCtx, 'auth' | 'runQuery'>;

async function authenticatedOwner(ctx: AnyCtx): Promise<string> {
  const userId = await getAuthUserId(ctx as SessionReader);
  if (userId === null) throw new ConvexError(OWNER_ERRORS.unauthenticated);
  await assertActiveOwner(ctx, userId);
  return userId;
}

async function verifyServerOwner(ctx: AnyCtx, args: ServerArgs, fence: OwnerFence): Promise<void> {
  await requireServer(args.serverToken);
  bounded(args.userId);
  if (fence === 'active') await assertActiveOwner(ctx, args.userId);
}

function ownedArgs<Args extends PropertyValidators>(args: ObjectType<Args>, userId: string): OwnedArgs<Args> {
  return { ...args, userId };
}

/** Drops the server credential so handlers never see or forward it. */
async function serverOwnedArgs<Args extends PropertyValidators>(
  ctx: AnyCtx,
  args: ObjectType<Args> & ServerArgs,
  fence: OwnerFence,
): Promise<ServerOwnedArgs<Args>> {
  await verifyServerOwner(ctx, args, fence);
  const { serverToken: _serverToken, ...owned } = args;
  return owned;
}

function withServerArgs<Args extends PropertyValidators>(args: Args): Args & typeof serverArgs {
  return { ...args, ...serverArgs };
}

export function authedQuery<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<QueryCtx, Args, Result>,
) {
  return query({
    args: definition.args,
    handler: async (ctx, args) => {
      const userId = await authenticatedOwner(ctx);
      return definition.handler(ctx, ownedArgs<Args>(args as ObjectType<Args>, userId));
    },
  });
}

export function authedMutation<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<MutationCtx, Args, Result>,
) {
  return mutation({
    args: definition.args,
    handler: async (ctx, args) => {
      const userId = await authenticatedOwner(ctx);
      return definition.handler(ctx, ownedArgs<Args>(args as ObjectType<Args>, userId));
    },
  });
}

export function authedAction<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<ActionCtx, Args, Result>,
) {
  return action({
    args: definition.args,
    handler: async (ctx, args) => {
      const userId = await authenticatedOwner(ctx);
      return definition.handler(ctx, ownedArgs<Args>(args as ObjectType<Args>, userId));
    },
  });
}

/** Worker reads: the server token vouches for `userId`; reads of a deleting owner are filtered per table. */
export function serverQuery<Args extends PropertyValidators, Result>(
  definition: ServerDefinition<QueryCtx, Args, Result>,
) {
  return query({
    args: withServerArgs<Args>(definition.args),
    handler: async (ctx, args) => {
      const owned = await serverOwnedArgs<Args>(ctx, args as ObjectType<Args> & ServerArgs, 'any');
      return definition.handler(ctx, owned);
    },
  });
}

export function serverMutation<Args extends PropertyValidators, Result>(
  definition: ServerDefinition<MutationCtx, Args, Result>,
) {
  return mutation({
    args: withServerArgs<Args>(definition.args),
    handler: async (ctx, args) => {
      const owned = await serverOwnedArgs<Args>(ctx, args as ObjectType<Args> & ServerArgs, 'active');
      return definition.handler(ctx, owned);
    },
  });
}

/** Account deletion lifecycle only: it must keep running after `account:begin` fences the owner. */
export function serverAccountMutation<Args extends PropertyValidators, Result>(
  definition: ServerDefinition<MutationCtx, Args, Result>,
) {
  return mutation({
    args: withServerArgs<Args>(definition.args),
    handler: async (ctx, args) => {
      const owned = await serverOwnedArgs<Args>(ctx, args as ObjectType<Args> & ServerArgs, 'any');
      return definition.handler(ctx, owned);
    },
  });
}

export function serverAction<Args extends PropertyValidators, Result>(
  definition: ServerDefinition<ActionCtx, Args, Result>,
) {
  return action({
    args: withServerArgs<Args>(definition.args),
    handler: async (ctx, args) => {
      const owned = await serverOwnedArgs<Args>(ctx, args as ObjectType<Args> & ServerArgs, 'active');
      return definition.handler(ctx, owned);
    },
  });
}
