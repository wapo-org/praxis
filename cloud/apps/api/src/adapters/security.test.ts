import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {assertPublicUrl, createSafeFetch, isPublicAddress} from './security.js';

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/ok') return void res.end('fine');
    if (url.pathname === '/to-private') return void res.writeHead(302, {location: 'http://10.0.0.5/secret'}).end();
    if (url.pathname === '/to-metadata') return void res.writeHead(302, {location: 'http://169.254.169.254/latest/meta-data'}).end();
    if (url.pathname === '/loop') {
      const n = Number(url.searchParams.get('n') ?? 0);
      return void res.writeHead(302, {location: `/loop?n=${n + 1}`}).end();
    }
    if (url.pathname === '/hop') return void res.writeHead(302, {location: '/ok'}).end();
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

/** Only the loopback fixture is allowed; everything else uses the production policy. */
const fixtureOnly = {allowHttp: true, isAllowedAddress: (a: string) => a === '127.0.0.1' || isPublicAddress(a)};

describe('SSRF guard', () => {
  it('classifies private, loopback, link-local, metadata and ULA addresses as non-public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it('rejects non-http(s) schemes, credentials and plain http by default', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'https://user:pw@example.com', 'http://example.com']) await expect(assertPublicUrl(url)).rejects.toThrow();
  });
  it('checks after DNS resolution: a public name resolving to a private address is blocked', async () => {
    const resolve = async () => [{address: '10.0.0.7', family: 4}];
    await expect(assertPublicUrl('https://innocent.example.com', {resolve})).rejects.toThrow('Private egress destination');
    await expect(assertPublicUrl('https://good.example.com', {resolve: async () => [{address: '93.184.216.34', family: 4}]})).resolves.toBeInstanceOf(URL);
  });
  it('blocks loopback with the production policy', async () => {
    await expect(createSafeFetch({allowHttp: true})(`${base}/ok`)).rejects.toThrow('Private egress destination');
  });
  it('rejects redirects by default and re-validates every hop when following', async () => {
    expect(await (await createSafeFetch(fixtureOnly)(`${base}/ok`)).text()).toBe('fine');
    await expect(createSafeFetch(fixtureOnly)(`${base}/hop`)).rejects.toThrow('Redirects are not allowed');
    expect(await (await createSafeFetch({...fixtureOnly, maxRedirects: 3})(`${base}/hop`)).text()).toBe('fine');
    await expect(createSafeFetch({...fixtureOnly, maxRedirects: 3})(`${base}/to-private`)).rejects.toThrow('Private egress destination');
    await expect(createSafeFetch({...fixtureOnly, maxRedirects: 3})(`${base}/to-metadata`)).rejects.toThrow('Private egress destination');
    await expect(createSafeFetch({...fixtureOnly, maxRedirects: 3})(`${base}/loop`)).rejects.toThrow('Too many redirects');
  });
});
