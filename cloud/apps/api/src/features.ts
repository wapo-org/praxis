import type {JsonObject} from '@praxis/protocol';
import type {FeatureContext, ListOptions, Store} from './contracts.js';
import type {ApiService} from './service.js';

/** Kinds clients see; feature writes to them invalidate bootstrap and announce a user change. */
const PUBLIC_KINDS = new Set(['chat', 'connector', 'skill', 'registry', 'attachment', 'consent', 'provider', 'model', 'preferences']);

/**
 * Owner-scoped feature context. The store is wrapped so feature modules (MCP, tools) that write rows
 * directly still invalidate the bootstrap cache and fan out `user.change` events like the core routes do.
 * Every call is pinned to `userId`; a feature can't read or write another owner's rows through it.
 */
export function featureContext(service: ApiService, userId: string, options: {fetch?: typeof fetch; encryptionKey?: string} = {}): FeatureContext {
  const inner = service.adapters.store;
  const pin = (requested: string) => {
    if (requested !== userId) throw new Error('Feature store access outside the authenticated owner');
  };
  const store: Store = {
    get: async (u, kind, id) => (pin(u), inner.get(u, kind, id)),
    list: async (u, kind, opts?: ListOptions) => (pin(u), inner.list(u, kind, opts)),
    changes: async (u, after, limit) => (pin(u), inner.changes(u, after, limit)),
    head: async u => (pin(u), inner.head(u)),
    put: async (u, kind, id, value: JsonObject, opts?: ListOptions) => {
      pin(u);
      const row = await inner.put(u, kind, id, value, opts);
      await service.adapters.kv.del(`bootstrap:${u}`);
      if (PUBLIC_KINDS.has(kind)) await service.changed(u, kind, id, 'upsert', value);
      return row;
    },
    delete: async (u, kind, id) => {
      pin(u);
      await inner.delete(u, kind, id);
      await service.adapters.kv.del(`bootstrap:${u}`);
      if (PUBLIC_KINDS.has(kind)) await service.changed(u, kind, id, 'delete');
    },
  };
  return {
    userId,
    store,
    kv: service.adapters.kv,
    fetch: options.fetch ?? fetch,
    local: service.local,
    ...(options.encryptionKey ? {encryptionKey: options.encryptionKey} : {}),
  };
}
