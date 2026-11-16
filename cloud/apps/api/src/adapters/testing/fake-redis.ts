import { Redis } from '@upstash/redis';
import { APPEND_EVENT_LUA } from '../upstash.js';
import { ACQUIRE_LEASE_LUA, RELEASE_LEASE_LUA, RENEW_LEASE_LUA } from '../leases.js';

/**
 * In-process stand-in for the Upstash REST endpoint, plugged into the real @upstash/redis client
 * as its requester, so command serialization and response deserialization are the client's own.
 * Our Lua scripts are emulated in JS line by line; the Lua itself is only exercised by the
 * env-gated live suite.
 */
type Entry = [id: string, fields: string[]];
interface Value {
  kind: 'string' | 'stream';
  data: string | Entry[];
  expiresAt?: number;
}

export class FakeRedis {
  private values = new Map<string, Value>();
  private offset = 0;
  readonly commands: string[][] = [];
  /** Lets KV TTL contract tests advance time. */
  advanceClock = (ms: number) => {
    this.offset += ms;
  };
  now = () => Date.now() + this.offset;

  client(options: { automaticDeserialization?: boolean } = {}): Redis {
    return new Redis({
      request: async <T>(req: { body?: unknown; path?: string[] }) => {
        const command = (req.body as unknown[]).map(String);
        this.commands.push(command);
        try {
          return { result: this.exec(command) as T };
        } catch (e) {
          return { error: (e as Error).message } as never;
        }
      },
      ...options,
    } as never);
  }

  keys(): string[] {
    return [...this.values.keys()].filter((k) => this.live(k));
  }

  private live(key: string): Value | undefined {
    const v = this.values.get(key);
    if (v?.expiresAt !== undefined && v.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return v;
  }

  private str(key: string): string | null {
    const v = this.live(key);
    if (!v) return null;
    if (v.kind !== 'string') throw new Error('WRONGTYPE');
    return v.data as string;
  }

  private stream(key: string, create = false): Entry[] {
    const v = this.live(key);
    if (!v) {
      if (!create) return [];
      const entries: Entry[] = [];
      this.values.set(key, { kind: 'stream', data: entries });
      return entries;
    }
    if (v.kind !== 'stream') throw new Error('WRONGTYPE');
    return v.data as Entry[];
  }

  private expire(key: string, ms: number) {
    const v = this.live(key);
    if (!v) return 0;
    v.expiresAt = this.now() + ms;
    return 1;
  }

  private incr(key: string) {
    const n = Number(this.str(key) ?? 0) + 1;
    const v = this.live(key);
    this.values.set(key, { kind: 'string', data: String(n), expiresAt: v?.expiresAt });
    return n;
  }

  private exec(c: string[]): unknown {
    const [name, ...a] = c;
    switch (name!.toUpperCase()) {
      case 'GET':
        return this.str(a[0]!);
      case 'SET': {
        const [key, value, ...opts] = a;
        const upper = opts.map((o) => o.toUpperCase());
        if (upper.includes('NX') && this.live(key!)) return null;
        let expiresAt: number | undefined;
        const ex = upper.indexOf('EX');
        const px = upper.indexOf('PX');
        if (ex >= 0) expiresAt = this.now() + Number(opts[ex + 1]) * 1000;
        if (px >= 0) expiresAt = this.now() + Number(opts[px + 1]);
        this.values.set(key!, { kind: 'string', data: value!, expiresAt });
        return 'OK';
      }
      case 'DEL':
        return a.reduce((n, k) => n + (this.live(k) && this.values.delete(k) ? 1 : 0), 0);
      case 'EXISTS':
        return a.filter((k) => this.live(k)).length;
      case 'INCR':
        return this.incr(a[0]!);
      case 'PEXPIRE':
        return this.expire(a[0]!, Number(a[1]));
      case 'EXPIRE':
        return this.expire(a[0]!, Number(a[1]) * 1000);
      case 'XRANGE':
        return this.xrange(a);
      case 'EVAL':
        return this.eval(a);
      default:
        throw new Error(`FakeRedis does not support ${name}`);
    }
  }

  private xrange([key, start, end, countWord, count]: string[]) {
    const seq = (id: string) => Number(id.split('-')[0]);
    const exclusive = start!.startsWith('(');
    const from = start === '-' ? -Infinity : seq(start!.replace('(', ''));
    const to = end === '+' ? Infinity : seq(end!);
    let entries = this.stream(key!).filter(([id]) => (exclusive ? seq(id) > from : seq(id) >= from) && seq(id) <= to);
    if (countWord?.toUpperCase() === 'COUNT') entries = entries.slice(0, Number(count));
    return entries.map(([id, fields]) => [id, [...fields]]);
  }

  private eval([script, numKeys, ...rest]: string[]) {
    const keys = rest.slice(0, Number(numKeys));
    const argv = rest.slice(Number(numKeys));
    switch (script) {
      case APPEND_EVENT_LUA: {
        let n = this.incr(keys[0]!);
        const entries = this.stream(keys[1]!, true);
        const last = entries.at(-1);
        if (last) {
          const seen = Number(last[0].split('-')[0]);
          if (n <= seen) {
            n = seen + 1;
            this.values.set(keys[0]!, { kind: 'string', data: String(n) });
          }
        }
        entries.push([`${n}-0`, ['p', argv[0]!]]);
        // MAXLEN ~ trims in whole macro-nodes; trimming exactly is an allowed behaviour.
        const maxLen = Number(argv[1]);
        if (entries.length > maxLen) entries.splice(0, entries.length - maxLen);
        this.expire(keys[1]!, Number(argv[2]) * 1000);
        this.expire(keys[0]!, Number(argv[3]) * 1000);
        return n;
      }
      case ACQUIRE_LEASE_LUA: {
        if (this.live(keys[0]!)) return null;
        const fence = this.incr(keys[1]!);
        this.values.set(keys[0]!, { kind: 'string', data: `${argv[0]}|${fence}`, expiresAt: this.now() + Number(argv[1]) });
        this.expire(keys[1]!, Number(argv[2]));
        return fence;
      }
      case RENEW_LEASE_LUA:
        if (this.str(keys[0]!) !== argv[0]) return 0;
        return this.expire(keys[0]!, Number(argv[1]));
      case RELEASE_LEASE_LUA:
        if (this.str(keys[0]!) !== argv[0]) return 0;
        this.values.delete(keys[0]!);
        return 1;
      default:
        throw new Error('FakeRedis: unknown script');
    }
  }
}
