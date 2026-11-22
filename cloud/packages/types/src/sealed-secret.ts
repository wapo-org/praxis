/** What every implicit conversion of a secret yields; the value itself only leaves through `reveal()`. */
export const REDACTED = '[redacted]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Key material in memory: logging, JSON, string coercion and inspection all print `[redacted]`. */
export class SealedSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  static of(value: string): SealedSecret {
    if (typeof value !== 'string') throw new TypeError('SealedSecret.of expects a string');
    return new SealedSecret(value);
  }

  /** The only accessor: call it at the last moment (an `Authorization` header, a cipher input). */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }
}
