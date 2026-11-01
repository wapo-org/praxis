import {INDEX_SKEW_MS, OWNER_LEASE_LUA, OWNER_UNLOCK_LUA, OWNER_WRITE_LUA, ownerAppendLua} from '../account-redis.js';
import {APPEND_EVENT_LUA, FIXED_WINDOW_LUA, RELEASE_LEASE_LUA, type RedisLike} from '../upstash.js';
const OWNED_APPEND_LUA = ownerAppendLua(APPEND_EVENT_LUA);

/**
 * In-memory stand-in for the Upstash REST client subset (strings + streams + our two Lua scripts).
 * It lets the shared contract suite exercise the adapter's key layout, serialization and cursor logic
 * offline; the live suite (env-gated) checks the same contract against real Upstash.
 */
export function fakeRedis() {
  let now = 0;
  const strings = new Map<string, {value: string; expires?: number}>();
  const zsets = new Map<string, Map<string, number>>();
  /** The owner-script guard: active check, prune expired index entries, then register keys with their expiry. */
  const owned = (active: string, index: string, at: string, entries: [string, number][]) => {
    if (live(active)?.value !== 'active') throw Error('Account unavailable');
    const z = zsets.get(index) ?? new Map<string, number>();
    for (const [k, score] of z) if (score <= Number(at) - INDEX_SKEW_MS) z.delete(k);
    for (const [k, score] of entries) z.set(k, score);
    zsets.set(index, z);
  };
  const dedup = new Map<string, string>();
  const streams = new Map<string, {id: number; fields: Record<string, string>}[]>();
  const live = (k: string) => {
    const e = strings.get(k);
    if (e && e.expires !== undefined && e.expires <= now) strings.delete(k);
    return strings.get(k);
  };
  const redis = {
    async zrange(k: string, start: number, stop: number) { return [...(zsets.get(k) ?? new Map()).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([m]) => m).slice(start, stop < 0 ? undefined : stop + 1); },
    async zrem(k: string, ...members: string[]) { let n = 0; for (const m of members) if (zsets.get(k)?.delete(m)) n++; return n; },
    async get(k: string) { return live(k)?.value ?? null; },
    async set(k: string, value: string, opts?: {ex?: number; px?: number; nx?: boolean}) {
      if (opts?.nx && live(k)) return null;
      const ms = opts?.ex !== undefined ? opts.ex * 1000 : opts?.px;
      strings.set(k, {value: String(value), ...(ms !== undefined ? {expires: now + ms} : {})});
      return 'OK';
    },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (strings.delete(k)) n++; if (streams.delete(k)) n++;if(zsets.delete(k))n++;for(const key of dedup.keys())if(key.startsWith(k+':'))dedup.delete(key); } return n; },
    async getdel(k: string) { const v = live(k)?.value ?? null; strings.delete(k); return v; },
    async eval(script: string, keys: string[], args: string[]) {
      if (script === OWNER_WRITE_LUA) { owned(keys[1]!, keys[2]!, args[2]!, [[keys[0]!, args[1] ? Number(args[2]) + Number(args[1]) * 1000 : Infinity]]); return redis.set(keys[0]!, args[0]!, args[1] ? {ex: Number(args[1])} : {}); }
      if (script === OWNER_LEASE_LUA) { owned(keys[1]!, keys[2]!, args[2]!, [[keys[0]!, Number(args[2]) + Number(args[1])]]); return redis.set(keys[0]!, args[0]!, {nx: true, px: Number(args[1])}); }
      if (script === OWNED_APPEND_LUA) { owned(keys[3]!, keys[4]!, args[4]!, keys.slice(0, 3).map(k => [k, Number(args[4]) + Number(args[2]) * 1000] as [string, number])); script = APPEND_EVENT_LUA; keys = keys.slice(0, 3); }
      if (script === FIXED_WINDOW_LUA) { const e = live(keys[0]!); const n = Number(e?.value ?? 0) + 1; const expires = e?.expires ?? now + Number(args[0]); strings.set(keys[0]!, {value: String(n), expires}); return [n, expires - now]; }
      if (script === APPEND_EVENT_LUA) {
        const d = `${keys[2]}:${args[3]}`;
        if (args[3] && dedup.has(d)) return dedup.get(d)!;
        const n = Number(live(keys[0]!)?.value ?? 0) + 1;
        strings.set(keys[0]!, {value: String(n)});
        const list = streams.get(keys[1]!) ?? [];
        list.push({id: n, fields: {payload: args[0]!}});
        const max = Number(args[1]);
        if (list.length > max) list.splice(0, list.length - max);
        streams.set(keys[1]!, list);
        const record = JSON.stringify({id: n, payload: JSON.parse(args[0]!)});
        if (args[3]) dedup.set(d, record);
        return record;
      }
      if (script === RELEASE_LEASE_LUA || script === OWNER_UNLOCK_LUA) return live(keys[0]!)?.value === args[0] ? (strings.delete(keys[0]!), 1) : 0;
      throw new Error('fake redis: unknown script');
    },
    async xrange(k: string, start: string, _end: string, count?: number) {
      const after = Number(start.replace(/^\(/, '').split('-')[0]);
      const out: Record<string, Record<string, string>> = {};
      for (const e of (streams.get(k) ?? []).filter(e => e.id > after).slice(0, count ?? Infinity)) out[`${e.id}-0`] = e.fields;
      return out;
    },
  };
  return {redis: redis as unknown as RedisLike, advance: (ms: number) => { now += ms; }, now: () => now, keys: () => [...strings.keys(), ...streams.keys(), ...zsets.keys()], index: (k: string) => [...(zsets.get(k) ?? new Map()).keys()]};
}
