/** Environment as read from `process.env`: values may be missing, empty or whitespace (all count as missing). */
export type Env = Record<string, string | undefined>;

export interface CredentialSlot<C> {
  /** 1-based slot number. The only identifier of a credential that may leave the process. */
  slot: number;
  credential: C;
}

export interface CredentialPool<C = string> {
  /** Name used in cool-down keys and logs. Never a key value. */
  service: string;
  /** Base variable names (slot 1). Further slots add `_2`, `_3`, … to each name. */
  names: readonly string[];
  /** Configured slots in ascending order, without gaps. */
  slots: readonly CredentialSlot<C>[];
  /** Startup warnings (variable names only): slots ignored because of a numbering gap. */
  warnings: readonly string[];
}

export interface PoolOptions {
  /** Defaults to the first variable name in lower case. */
  service?: string;
}

/** `NAME` is slot 1, `NAME_2` slot 2, … */
export const slotSuffix = (slot: number) => (slot === 1 ? '' : `_${slot}`);

const present = (env: Env, name: string) => !!env[name]?.trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads a credential pool from the environment: `NAME`, `NAME_2`, `NAME_3`, … until the first gap.
 * A credential made of several variables forms one slot per suffix (`ID` + `SECRET`, `ID_2` + `SECRET_2`);
 * a slot with only some of its parts throws, so startup fails closed. Slots after a gap are ignored and named
 * in `warnings`. Adding `NAME_n` to the environment adds a slot with no code change.
 */
export function pool(name: string, env: Env, options?: PoolOptions): CredentialPool<string>;
export function pool(names: readonly string[], env: Env, options?: PoolOptions): CredentialPool<Record<string, string>>;
export function pool(nameOrNames: string | readonly string[], env: Env, options: PoolOptions = {}): CredentialPool<string> | CredentialPool<Record<string, string>> {
  const single = typeof nameOrNames === 'string';
  const names = single ? [nameOrNames] : [...nameOrNames];
  if (!names.length || names.some(n => !/^[A-Z][A-Z0-9_]*$/.test(n))) throw new Error('Credential pool names must be upper-case environment variable names');
  const service = options.service ?? names[0]!.toLowerCase();
  const slots: CredentialSlot<string | Record<string, string>>[] = [];
  for (let slot = 1; ; slot++) {
    const vars = names.map(n => `${n}${slotSuffix(slot)}`);
    const missing = vars.filter(v => !present(env, v));
    if (missing.length === vars.length) break;
    if (missing.length) throw new Error(`Credential slot ${slot} of ${service} is half-defined: ${missing.join(', ')} is missing while ${vars.filter(v => !missing.includes(v)).join(', ')} is set`);
    const values = vars.map(v => env[v]!.trim());
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
  return {service, names, slots, warnings} as CredentialPool<string> | CredentialPool<Record<string, string>>;
}
