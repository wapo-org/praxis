import {describe, expect, it} from 'vitest';
import {classifyHttp} from './index.js';

const now = () => Date.parse('2026-11-15T12:00:00Z');

describe('classifyHttp', () => {
  it('treats success and ordinary client errors as ok', () => {
    for (const status of [200, 204, 400, 404, 422]) expect(classifyHttp(status, {})).toEqual({kind: 'ok'});
  });

  it('cools an invalid key for an hour', () => {
    expect(classifyHttp(401, {})).toEqual({kind: 'invalid', cooldownMs: 3_600_000});
    expect(classifyHttp(403)).toEqual({kind: 'invalid', cooldownMs: 3_600_000});
  });

  it('reads 402 and quota bodies as exhausted, with a configurable period', () => {
    expect(classifyHttp(402, {})).toEqual({kind: 'exhausted', cooldownMs: 3_600_000});
    expect(classifyHttp(429, {}, '{"error":{"code":"insufficient_quota"}}')).toEqual({kind: 'exhausted', cooldownMs: 3_600_000});
    expect(classifyHttp(403, {}, 'You have exceeded your current quota')).toMatchObject({kind: 'exhausted'});
    expect(classifyHttp(200, {}, 'quota exceeded')).toEqual({kind: 'ok'});
    expect(classifyHttp(402, {}, undefined, {cooldownsMs: {exhausted: 5000}})).toEqual({kind: 'exhausted', cooldownMs: 5000});
    expect(classifyHttp(400, {}, 'plan limit reached', {quotaBody: /plan limit/})).toMatchObject({kind: 'exhausted'});
  });

  it('classifies repeated quota matches without changing a stateful regex', () => {
    const quotaBody = /plan limit/g;
    quotaBody.lastIndex = 3;
    const options = {quotaBody};

    expect(classifyHttp(400, {}, 'plan limit', options).kind).toBe('exhausted');
    expect(classifyHttp(400, {}, 'plan limit', options).kind).toBe('exhausted');
    expect(quotaBody.lastIndex).toBe(3);
  });

  it('uses Retry-After seconds or an HTTP-date for 429, else 60 s', () => {
    expect(classifyHttp(429, {})).toEqual({kind: 'rateLimited', cooldownMs: 60_000});
    expect(classifyHttp(429, new Headers({'Retry-After': '7'}))).toEqual({kind: 'rateLimited', cooldownMs: 7000});
    expect(classifyHttp(429, {'Retry-After': 'Sun, 15 Nov 2026 12:00:30 GMT'}, undefined, {now})).toEqual({kind: 'rateLimited', cooldownMs: 30_000});
    expect(classifyHttp(429, {'retry-after': 'soon'})).toEqual({kind: 'rateLimited', cooldownMs: 60_000});
    expect(classifyHttp(429, {'retry-after': '0'})).toEqual({kind: 'rateLimited', cooldownMs: 1000});
    expect(classifyHttp(429, {'retry-after': '999999'})).toEqual({kind: 'rateLimited', cooldownMs: 3_600_000});
    expect(classifyHttp(429, {'retry-after': 'Sun, 15 Nov 2026 11:00:00 GMT'}, undefined, {now})).toEqual({kind: 'rateLimited', cooldownMs: 1000});
  });

  it('gives server errors a short cool-down', () => {
    expect(classifyHttp(503, {})).toEqual({kind: 'serverError', cooldownMs: 15_000});
  });
});
