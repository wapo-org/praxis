import {afterEach, describe, expect, it} from 'vitest';
import {waitUntil} from '../wait-until.js';

const KEY = Symbol.for('@vercel/request-context');
afterEach(() => { delete (globalThis as Record<symbol, unknown>)[KEY]; });

describe('waitUntil', () => {
  it('hands work to the Vercel request context when present', () => {
    const seen: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[KEY] = {get: () => ({waitUntil: (p: Promise<unknown>) => seen.push(p)})};
    const work = Promise.resolve(1);
    waitUntil(work);
    expect(seen).toEqual([work]);
  });
  it('is a no-op outside Vercel', () => {
    expect(() => waitUntil(Promise.resolve())).not.toThrow();
  });
});
