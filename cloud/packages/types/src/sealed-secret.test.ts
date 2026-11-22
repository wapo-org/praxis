import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {inspect} from 'node:util';
import {describe, expect, it} from 'vitest';
import {REDACTED, SealedSecret} from './index.js';

const VALUE = 'sk-or-v1-NEVER-PRINT-THIS-0123456789';

describe('SealedSecret', () => {
  it('gives the value back only through reveal()', () => {
    expect(SealedSecret.of(VALUE).reveal()).toBe(VALUE);
  });

  it('never appears in JSON, however deeply it is nested', () => {
    const secret = SealedSecret.of(VALUE);
    const text = JSON.stringify({secret, nested: {list: [secret], map: {key: secret}}});
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text)).toEqual({secret: REDACTED, nested: {list: [REDACTED], map: {key: REDACTED}}});
  });

  it('never appears in what console.log, console.error or util.inspect write', () => {
    const secret = SealedSecret.of(VALUE);
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        done();
      },
    });
    const logger = new Console(sink, sink);
    logger.log({holder: {secret}}, secret);
    logger.error('failed with %s and %o', secret, {secret});
    logger.log(new Error(`request failed for ${secret}`, {cause: {secret}}));
    written.push(inspect({secret}, {depth: null, showHidden: true, getters: true}));
    expect(written.join('\n')).toContain(REDACTED);
    expect(written.join('\n')).not.toContain(VALUE);
  });

  it('redacts string coercion and exposes no enumerable or own value', () => {
    const secret = SealedSecret.of(VALUE);
    expect(`${secret}`).toBe(REDACTED);
    expect(String(secret)).toBe(REDACTED);
    expect(`Bearer ${secret}`).toBe(`Bearer ${REDACTED}`);
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect({...secret}).toEqual({});
    expect(Object.isFrozen(secret)).toBe(true);
  });

  it('is not constructible from a non-string', () => {
    expect(() => SealedSecret.of(undefined as unknown as string)).toThrow(TypeError);
  });
});
