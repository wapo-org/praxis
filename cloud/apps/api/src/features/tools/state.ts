import type {JsonObject} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import type {ToolsStorage, ToolsState} from './ports.js';

/** Generic Store is already durable/user-scoped; a dedicated tools adapter can isolate tool state. */
export function toolsState(ctx: FeatureContext, storage?: ToolsStorage): ToolsState {
  return storage?.state ?? {
    async get(userId, kind, id) {const row = await ctx.store.get(userId, `tools:${kind}`, id); return row && !row.deleted ? row.value : null;},
    async put(userId, kind, id, value) {await ctx.store.put(userId, `tools:${kind}`, id, value);},
    async delete(userId, kind, id) {await ctx.store.delete(userId, `tools:${kind}`, id);},
  };
}
export function createLocalToolsState(): ToolsState {
  const rows = new Map<string, JsonObject>();
  const key = (userId: string, kind: string, id: string) => JSON.stringify([userId, kind, id]);
  return {
    async get(userId, kind, id) {return structuredClone(rows.get(key(userId, kind, id)) ?? null);},
    async put(userId, kind, id, value) {rows.set(key(userId, kind, id), structuredClone(value));},
    async delete(userId, kind, id) {rows.delete(key(userId, kind, id));},
  };
}
