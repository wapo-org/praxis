import type {JsonObject} from '@praxis/protocol';
import type {Store} from './contracts.js';
import {MODEL_KEY_RESOURCE, SEALED_FIELD} from './openrouter/keys.js';
import {parseKeyring, seal, sealedWithCurrent, unseal} from './secrets.js';

/** Maps stored secret kinds to AES-GCM AAD resource strings; keep old keys 10m for Redis OAuth state. */
export const SECRET_KINDS: Record<string, (id: string, field: string) => string | null> = {
  modelKey: (_id, field) => (field === SEALED_FIELD ? MODEL_KEY_RESOURCE : null),
  voiceSecret: (_id, field) => (field === 'key' ? 'voice' : null),
  mcpSecret: (id, field) => `mcp:${id}:${field}`,
};

export interface RotationStats {owners: number; rows: number; rewritten: number; failed: number}

/** Re-seals owner secrets with current key; unreadable values are counted, never dropped. */
export async function reencryptOwner(store: Store, userId: string, keyring: string, stats: RotationStats, dryRun = false) {
  parseKeyring(keyring);
  stats.owners++;
  for (const [kind, resourceOf] of Object.entries(SECRET_KINDS)) {
    for (const listed of await store.list(userId, kind)) {
      stats.rows++;
      let row = listed;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (row.deleted) break;
        const next: JsonObject = {...row.value};
        let changed = false, failed = 0;
        for (const [field, value] of Object.entries(row.value)) {
          const resource = resourceOf(row.id, field);
          if (!resource || typeof value !== 'string' || !/^v[12]\./.test(value) || sealedWithCurrent(value, keyring)) continue;
          try {
            next[field] = seal(unseal(value, userId, resource, keyring), userId, resource, keyring);
            changed = true;
          } catch { failed++; }
        }
        if (!changed || dryRun || await store.putIfRevision(userId, kind, row.id, next, row.revision,
          row.parentId === undefined ? undefined : {parentId: row.parentId})) {
          stats.failed += failed;
          if (changed) stats.rewritten++;
          break;
        }
        const current = await store.get(userId, kind, row.id);
        if (!current || current.deleted) break;
        row = current;
        if (attempt === 9) stats.failed++; // bounded contention: report failure, never overwrite
      }
    }
  }
}

export async function reencryptAll(store: Store, owners: AsyncIterable<string> | Iterable<string>, keyring: string, dryRun = false): Promise<RotationStats> {
  const stats: RotationStats = {owners: 0, rows: 0, rewritten: 0, failed: 0};
  for await (const userId of owners) await reencryptOwner(store, userId, keyring, stats, dryRun);
  return stats;
}
