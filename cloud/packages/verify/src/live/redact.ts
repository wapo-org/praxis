import {REDACTED, SealedSecret} from '@praxis/types';

/** Env names whose values are treated as secrets even when no step declares them. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PAT)(_\d+)?$/;
/** Known key shapes, caught even when the value never passed through the environment. */
const KEY_SHAPES: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces known secret values and key shapes with `[redacted]`; applied to every string a proof stores. */
export class Redactor {
  readonly #values = new Set<string>();

  add(secret: SealedSecret | string): this {
    const value = typeof secret === 'string' ? secret : secret.reveal();
    if (!value) return this;
    this.#values.add(value);
    // JSON-escaped and URL-encoded forms reach logs too.
    this.#values.add(JSON.stringify(value).slice(1, -1));
    this.#values.add(encodeURIComponent(value));
    return this;
  }

  addEnv(env: Record<string, string | undefined>): this {
    for (const [name, value] of Object.entries(env)) if (value && SECRET_NAME.test(name)) this.add(value.trim());
    return this;
  }

  apply(text: string): string {
    let result = text;
    const longestFirst = [...this.#values].sort((a, b) => b.length - a.length);
    for (const value of longestFirst) result = result.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED);
    for (const shape of KEY_SHAPES) result = result.replace(shape, (_match, prefix: unknown) => (typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED));
    return result;
  }
}
