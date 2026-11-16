import {afterEach, describe, expect, it, vi} from 'vitest';
import {API_CHECKS, ApiClient} from './api-smoke.js';

afterEach(() => vi.unstubAllGlobals());

describe('api smoke', () => {
  it('fails a check whose response violates the protocol schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({type: 'bootstrap', user: {id: 123}})));
    const bootstrap = API_CHECKS.find(check => check.id === 'bootstrap')!;
    await expect(bootstrap.run(new ApiClient('http://127.0.0.1:1'), new Map())).rejects.toThrow(/violates the protocol/);
  });
});
