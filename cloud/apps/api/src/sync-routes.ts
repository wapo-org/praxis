import {createHash} from 'node:crypto';
import type {Hono} from 'hono';
import {SyncRequestSchema, type JsonValue} from '@praxis/protocol';
import type {StoredRecord} from './contracts.js';
import {ApiError, type ApiService} from './service.js';

/** Kinds a client replica holds. Secrets, checkpoints, idempotency rows and other server state never sync. */
export const SYNC_KINDS = new Set(['chat', 'message', 'provider', 'model', 'connector', 'skill', 'registry', 'consent', 'preferences', 'attachment', 'run']);

/** Canonical JSON: sorted object keys, no whitespace; SHA-256 hex. Reproducible in Swift. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
}
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
    return c.json({type: 'sync.root', root: '', cursor: String(latest), strategy: 'cursor'});
  });
  app.get('/v1/sync/pull', async c => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 500) || 500));
    return c.json(await pullChanges(service, c.get('userId'), parseCursor(c.req.query('cursor')), limit));
  });
  app.post('/v1/sync/pull', async c => {
    let data: unknown;
    try { data = await c.req.json(); } catch { throw new ApiError(400, 'invalid_json', 'Expected a JSON request body'); }
    const input = SyncRequestSchema.parse(data);
    return c.json(await pullChanges(service, c.get('userId'), parseCursor(input.cursor), input.limit));
  });
}

