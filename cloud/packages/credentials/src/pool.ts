import {SealedSecret} from '@praxis/types';

/** Empty or whitespace env values count as missing. */
export type Env = Record<string, string | undefined>;

export interface CredentialSlot<C> {
  /** 1-based slot number; the only credential identifier allowed out of process. */
  slot: number;
  credential: C;
}

export interface CredentialPool<C = SealedSecret> {
  /** Service name for cool-down keys and logs; never a key value. */
  service: string;
  names: readonly string[];
  slots: readonly CredentialSlot<C>[];
  warnings: readonly string[];
}

export interface PoolOptions {
  service?: string;
}

export const slotSuffix = (slot: number) => (slot === 1 ? '' : `_${slot}`);

const present = (env: Env, name: string) => !!env[name]?.trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads NAME, NAME_2... slots until first gap; partial multi-var slots fail closed. */
export function pool(name: string, env: Env, options?: PoolOptions): CredentialPool<SealedSecret>;
export function pool(names: readonly string[], env: Env, options?: PoolOptions): CredentialPool<Record<string, SealedSecret>>;
export function pool(nameOrNames: string | readonly string[], env: Env, options: PoolOptions = {}): CredentialPool<SealedSecret> | CredentialPool<Record<string, SealedSecret>> {
  const single = typeof nameOrNames === 'string';
  const names = single ? [nameOrNames] : [...nameOrNames];
  if (!names.length || names.some(n => !/^[A-Z][A-Z0-9_]*$/.test(n))) throw new Error('Credential pool names must be upper-case environment variable names');
  const service = options.service ?? names[0]!.toLowerCase();
  const slots: CredentialSlot<SealedSecret | Record<string, SealedSecret>>[] = [];
  for (let slot = 1; ; slot++) {
    const vars = names.map(n => `${n}${slotSuffix(slot)}`);
    const missing = vars.filter(v => !present(env, v));
    if (missing.length === vars.length) break;
    if (missing.length) throw new Error(`Credential slot ${slot} of ${service} is half-defined: ${missing.join(', ')} is missing while ${vars.filter(v => !missing.includes(v)).join(', ')} is set`);
    const values = vars.map(v => SealedSecret.of(env[v]!.trim()));
    slots.push({slot, credential: single ? values[0]! : Object.fromEntries(names.map((n, i) => [n, values[i]!]))});
  }
  const ignored: {name: string; slot: number}[] = [];
  for (const base of names) {
    const pattern = new RegExp(`^${escape(base)}_([1-9]\\d*)$`);
    for (const key of Object.keys(env)) {
      const n = Number(pattern.exec(key)?.[1]);
      if (present(env, key) && (n === 1 || n > slots.length)) ignored.push({name: key, slot: n});
    }
  }
  ignored.sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name));
  const gap = names.map(n => `${n}${slotSuffix(slots.length + 1)}`).join(' + ');
  const warnings = ignored.map(i => i.slot === 1
    ? `${i.name} is ignored: slot 1 of ${service} is the name without a suffix`
    : `${i.name} is ignored: ${gap} is missing, and slots must be numbered without gaps`);
  return {service, names, slots, warnings} as CredentialPool<SealedSecret> | CredentialPool<Record<string, SealedSecret>>;
}
