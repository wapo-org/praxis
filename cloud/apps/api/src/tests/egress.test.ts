import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createSafeFetch} from '../adapters/security.js';
import {featureContext} from '../features.js';
import {publicFetch} from '../features/tools/http.js';
import {createLocalAdapters} from '../local-memory.js';
import {ApiService} from '../service.js';

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((_req, res) => res.end('pinned'));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('tool egress (REV-A1 P0 http.ts:15 DNS rebinding)', () => {
  it('resolves once, validates, and dials the pinned address even if DNS changes afterwards', async () => {
    let lookups = 0;
    // First answer is the (test-allowed) fixture; any later answer would be a private address.
    const resolve = async () => (lookups++ === 0 ? [{address: '127.0.0.1', family: 4}] : [{address: '10.9.9.9', family: 4}]);
    const egress = createSafeFetch({allowHttp: true, resolve, isAllowedAddress: a => a === '127.0.0.1'});
    const ctx = {...featureContext(new ApiService(createLocalAdapters(), true), 'alice'), egress};
    const {response, bytes} = await publicFetch(ctx, `http://rebind.example.test:${port}/`);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(bytes)).toBe('pinned');
    expect(lookups).toBe(1);
  });

  it('blocks a name whose single resolution is private', async () => {
    const egress = createSafeFetch({allowHttp: true, resolve: async () => [{address: '169.254.169.254', family: 4}]});
    const ctx = {...featureContext(new ApiService(createLocalAdapters(), true), 'alice'), egress};
    await expect(publicFetch(ctx, 'http://metadata.example.test/latest')).rejects.toMatchObject({status: 403, code: 'network_denied'});
  });

  it('feature contexts default to the guarded egress, which refuses loopback even in local mode', async () => {
    const ctx = featureContext(new ApiService(createLocalAdapters(), true), 'alice');
    await expect(ctx.egress(`http://127.0.0.1:${port}/`)).rejects.toThrow('Private egress destination');
  });
});
