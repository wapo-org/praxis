import {OWNER_WRITE_LUA,OWNER_LIMIT_LUA,OWNER_UNLOCK_LUA} from '../account-redis.js';
import {APPEND_EVENT_LUA, RELEASE_LEASE_LUA, type RedisLike} from '../upstash.js';

/**
 * In-memory stand-in for the Upstash REST client subset (strings + streams + our two Lua scripts).
 * It lets the shared contract suite exercise the adapter's key layout, serialization and cursor logic
 * offline; the live suite (env-gated) checks the same contract against real Upstash.
 */
export function fakeRedis() {
  let now = 0;
  const strings = new Map<string, {value: string; expires?: number}>();
  const sets=new Map<string,Set<string>>();
  const dedup = new Map<string, string>();
  const streams = new Map<string, {id: number; fields: Record<string, string>}[]>();
  const live = (k: string) => {
    const e = strings.get(k);
    if (e && e.expires !== undefined && e.expires <= now) strings.delete(k);
    return strings.get(k);
  };
  const redis = {
    async smembers(k:string){return [...(sets.get(k)??[])];},
    async get(k: string) { return live(k)?.value ?? null; },
    async set(k: string, value: string, opts?: {ex?: number; px?: number; nx?: boolean}) {
      if (opts?.nx && live(k)) return null;
      const ms = opts?.ex !== undefined ? opts.ex * 1000 : opts?.px;
      strings.set(k, {value: String(value), ...(ms !== undefined ? {expires: now + ms} : {})});
      return 'OK';
    },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (strings.delete(k)) n++; if (streams.delete(k)) n++;if(sets.delete(k))n++;for(const key of dedup.keys())if(key.startsWith(k+':'))dedup.delete(key); } return n; },
    async getdel(k: string) { const v = live(k)?.value ?? null; strings.delete(k); return v; },
    async eval(script: string, keys: string[], args: string[]) {
      if(script===OWNER_WRITE_LUA){if(live(keys[0]!)?.value!=='active')throw Error('Account unavailable');sets.set(keys[1]!,new Set([...(sets.get(keys[1]!)??[]),keys[2]!]));return redis.set(keys[2]!,args[0]!,args[1]?{ex:Number(args[1])}:{});}
      if(script===OWNER_LIMIT_LUA){if(live(keys[0]!)?.value!=='active')return -1;sets.set(keys[1]!,new Set([...(sets.get(keys[1]!)??[]),keys[2]!]));const n=Number(live(keys[2]!)?.value??0)+1;await redis.set(keys[2]!,String(n),{ex:Number(args[0])});return n;}
      if(script.endsWith(APPEND_EVENT_LUA)&&script!==APPEND_EVENT_LUA){if(live(keys[3]!)?.value!=='active')throw Error('Account unavailable');sets.set(keys[4]!,new Set([...(sets.get(keys[4]!)??[]),...keys.slice(0,3)]));script=APPEND_EVENT_LUA;}
      if(script.includes("return redis.call('SET',KEYS[3],ARGV[1],'NX','PX',ARGV[2])")){if(live(keys[0]!)?.value!=='active')throw Error('Account unavailable');sets.set(keys[1]!,new Set([...(sets.get(keys[1]!)??[]),keys[2]!]));return redis.set(keys[2]!,args[0]!,{nx:true,px:Number(args[1])});}
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
  return {redis: redis as unknown as RedisLike, advance: (ms: number) => { now += ms; }, keys: () => [...strings.keys(), ...streams.keys(),...sets.keys()]};
}
