import type {QueryCtx} from './functions.js';
import type {Id} from './_generated/dataModel.js';

export const ACCOUNT_PURGE_BATCH_MAX = 100;
export const ACCOUNT_OWNER_QUERIES = {
  runs: (ctx: QueryCtx, userId: string) => ctx.db.query('runs').withIndex('owner_chat', q => q.eq('userId', userId)),
  records: (ctx: QueryCtx, userId: string) => ctx.db.query('records').withIndex('owner_kind_id', q => q.eq('userId', userId)),
  changes: (ctx: QueryCtx, userId: string) => ctx.db.query('changes').withIndex('owner_revision', q => q.eq('userId', userId)),
  sequences: (ctx: QueryCtx, userId: string) => ctx.db.query('sequences').withIndex('owner', q => q.eq('userId', userId)),
  toolState: (ctx: QueryCtx, userId: string) => ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId)),
  toolSkillFiles: (ctx: QueryCtx, userId: string) => ctx.db.query('toolSkillFiles').withIndex('owner_skill', q => q.eq('userId', userId)),
  files: (ctx: QueryCtx, userId: string) => ctx.db.query('files').withIndex('owner_status', q => q.eq('userId', userId)),
  embeddings: (ctx: QueryCtx, userId: string) => ctx.db.query('embeddings').withIndex('owner', q => q.eq('userId', userId)),
};

export const ACCOUNT_RUN_CHILD_QUERIES = {
  turnFlags: (ctx: QueryCtx, runId: Id<'runs'>) => ctx.db.query('turnFlags')
    .withIndex('run_generation_turn', q => q.eq('runId', runId)),
};
