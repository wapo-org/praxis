import type {QueryCtx} from './functions.js';
import type {Id, TableNames} from './_generated/dataModel.js';

export const ACCOUNT_PURGE_BATCH_MAX = 100;

// Every table names its deletion policy; `satisfies` makes a table added without one a type error.
export const ACCOUNT_PURGE_POLICY = {
  records: 'ownerRows',
  changes: 'ownerRows',
  sequences: 'ownerRows',
  toolState: 'ownerRows',
  toolSkillFiles: 'ownerRows',
  files: 'ownerRows',
  embeddings: 'ownerRows',
  oauthEmails: 'identity',
  runs: 'workflowRun',
  turnFlags: 'runChild',
  authDocuments: 'identity',
  users: 'identity',
} as const satisfies Record<TableNames, 'ownerRows' | 'workflowRun' | 'runChild' | 'identity'>;

type Policy = typeof ACCOUNT_PURGE_POLICY;
type TablesWith<P> = {[T in keyof Policy]: Policy[T] extends P ? T : never}[keyof Policy];
type PurgedRow = {_id: Id<TableNames>; storageId?: Id<'_storage'>};
type RowsBy<K> = (ctx: QueryCtx, key: K, limit: number) => Promise<PurgedRow[]>;

export const ACCOUNT_OWNER_ROWS: Record<TablesWith<'ownerRows'>, RowsBy<string>> = {
  records: (ctx, userId, limit) => ctx.db.query('records')
    .withIndex('owner_kind_id', q => q.eq('userId', userId)).take(limit),
  changes: (ctx, userId, limit) => ctx.db.query('changes')
    .withIndex('owner_revision', q => q.eq('userId', userId)).take(limit),
  sequences: (ctx, userId, limit) => ctx.db.query('sequences')
    .withIndex('owner', q => q.eq('userId', userId)).take(limit),
  toolState: (ctx, userId, limit) => ctx.db.query('toolState')
    .withIndex('owner_kind_id', q => q.eq('userId', userId)).take(limit),
  toolSkillFiles: (ctx, userId, limit) => ctx.db.query('toolSkillFiles')
    .withIndex('owner_skill', q => q.eq('userId', userId)).take(limit),
  files: (ctx, userId, limit) => ctx.db.query('files')
    .withIndex('owner_status', q => q.eq('userId', userId)).take(limit),
  embeddings: (ctx, userId, limit) => ctx.db.query('embeddings')
    .withIndex('owner', q => q.eq('userId', userId)).take(limit),
};

export const ACCOUNT_RUN_CHILD_ROWS: Record<TablesWith<'runChild'>, RowsBy<Id<'runs'>>> = {
  turnFlags: (ctx, runId, limit) => ctx.db.query('turnFlags')
    .withIndex('run_generation_turn', q => q.eq('runId', runId)).take(limit),
};
