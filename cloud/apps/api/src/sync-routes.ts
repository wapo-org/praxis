import {createHash} from 'node:crypto';
import type {Hono} from 'hono';
import {SyncRequestSchema, type JsonValue} from '@praxis/protocol';
import {HashTree, canonicalJSON, respondMerkle} from '@praxis/sync';
import type {StoredRecord} from './contracts.js';
import {ApiError, type ApiService} from './service.js';

/** Kinds a client replica holds. Secrets, checkpoints, idempotency rows and other server state never sync. */
export const SYNC_KINDS = new Set(['chat', 'message', 'provider', 'model', 'connector', 'skill', 'registry', 'consent', 'preferences', 'attachment', 'run']);

export {canonicalJSON};
export const entityHash = (value: unknown) => createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex');

function entity(record: StoredRecord) {
  return {
    type: 'sync.entity' as const,
    key: `${record.kind}:${record.id}`,
    hash: record.deleted ? 'tombstone' : entityHash(record.value),
    updatedAt: record.updatedAt,
    deleted: record.deleted,
    value: record.deleted ? null : (record.value as JsonValue),
  };
}

function parseCursor(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ApiError(400, 'invalid_cursor', 'Invalid sync cursor');
  return Number(raw);
}

/** Cursor sync over the store's monotonic revision log (never wall-clock), so simultaneous writes can't be skipped. */
export async function pullChanges(service: ApiService, userId: string, after: number, limit: number) {
  const entities = new Map<string, ReturnType<typeof entity>>();
  let cursor = after;
  let hasMore = true;
  // Skip non-sync kinds without returning short pages forever; bounded by a few store reads per request.
  for (let reads = 0; reads < 5 && hasMore && entities.size < limit; reads++) {
    const batch = await service.adapters.store.changes(userId, cursor, limit);
    for (const record of batch.records) {
      if (!SYNC_KINDS.has(record.kind)) continue;
      const e = entity(record);
      entities.delete(e.key);
      entities.set(e.key, e);
    }
    cursor = batch.cursor;
    hasMore = batch.hasMore;
  }
  return {
    type: 'sync.response' as const,
    strategy: 'cursor' as const,
    root: '',
    cursor: String(cursor),
    entities: [...entities.values()],
    nextCursor: hasMore ? String(cursor) : null,
    nodes: [],
  };
}

export function registerSyncRoutes(app: Hono<any>, service: ApiService) {
  app.get('/v1/sync/root', async c => {
    const latest = await service.adapters.store.head(c.get('userId'));
    const strategy = syncStrategy(service);
    const root = strategy === 'merkle' ? await (await serverTree(service, c.get('userId'))).tree.root() : '';
    return c.json({type: 'sync.root', root, cursor: String(latest), strategy});
  });
  app.get('/v1/sync/pull', async c => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 500) || 500));
    return c.json(await pullChanges(service, c.get('userId'), parseCursor(c.req.query('cursor')), limit));
  });
  app.post('/v1/sync/pull', async c => {
    let data: unknown;
    try { data = await c.req.json(); } catch { throw new ApiError(400, 'invalid_json', 'Expected a JSON request body'); }
    const input = SyncRequestSchema.parse(data);
    if (input.strategy === 'merkle') return c.json((await merkle(service, c.get('userId'), input)) as object);
    return c.json(await pullChanges(service, c.get('userId'), parseCursor(input.cursor), input.limit));
  });
  app.post('/v1/sync/tree', async c => {
    let data: unknown;
    try { data = await c.req.json(); } catch { throw new ApiError(400, 'invalid_json', 'Expected a JSON request body'); }
    return c.json((await merkle(service, c.get('userId'), SyncRequestSchema.parse(data))) as object);
  });
}


/** Cursor sync won the experiment (docs/SYNC_EXPERIMENT.md); Merkle stays available behind PRAXIS_SYNC_STRATEGY=merkle (and locally). */
export function syncStrategy(service: ApiService): 'cursor' | 'merkle' {
  void service;
  return process.env.PRAXIS_SYNC_STRATEGY === 'merkle' ? 'merkle' : 'cursor';
}

const trees = new Map<string, {head: number; tree: HashTree; rows: Map<string, StoredRecord>}>();

/** Builds the owner's tree from the store; reused while the owner's head revision is unchanged (process-local cache). */
async function serverTree(service: ApiService, userId: string) {
  const head = await service.adapters.store.head(userId);
  const cached = trees.get(userId);
  if (cached && cached.head === head) return cached;
  const tree = new HashTree();
  const rows = new Map<string, StoredRecord>();
  for (const kind of SYNC_KINDS) {
    for (const record of await service.adapters.store.list(userId, kind)) {
      const key = `${record.kind}:${record.id}`;
      rows.set(key, record);
      tree.set(key, entityHash(record.value));
    }
  }
  const entry = {head, tree, rows};
  trees.delete(userId);
  trees.set(userId, entry);
  if (trees.size > 100) trees.delete(trees.keys().next().value!);
  return entry;
}

async function merkle(service: ApiService, userId: string, input: {root?: string | undefined; prefixes?: string[] | undefined}) {
  if (!service.local && syncStrategy(service) !== 'merkle') throw new ApiError(404, 'strategy_disabled', 'Merkle sync is disabled; use cursor sync');
  const {head, tree, rows} = await serverTree(service, userId);
  try {
    return await respondMerkle(tree, {...(input.root !== undefined ? {root: input.root} : {}), ...(input.prefixes ? {prefixes: input.prefixes} : {})}, String(head), async keys => keys.flatMap(k => {
      const r = rows.get(k);
      return r ? [entity(r)] : [];
    }));
  } catch (e) {
    if (e instanceof RangeError) throw new ApiError(400, 'invalid_prefixes', 'Invalid sync prefixes');
    throw e;
  }
}
