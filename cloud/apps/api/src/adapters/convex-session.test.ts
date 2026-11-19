import { afterEach, expect, it, vi } from 'vitest';
import { verifiedConvexOwner } from './convex-session.js';

const deployment = 'https://auth-test.convex.cloud';
const request = new Request('https://api.example.test/v1/bootstrap?userId=forged', {
  headers: { authorization: 'Bearer session-for-test' },
});

afterEach(() => vi.unstubAllGlobals());

it('sends the bearer to the configured deployment and accepts only its verified owner', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'success', value: 'verified-owner' }));
  vi.stubGlobal('fetch', fetcher);
  expect(await verifiedConvexOwner(request, deployment)).toBe('verified-owner');
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(deployment + '/api/query');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-for-test');
  expect(init?.redirect).toBe('error');
});

it('rejects an invalid bearer and propagates backend outages', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response('backend unavailable', { status: 503 })));
  expect(await verifiedConvexOwner(request, deployment)).toBeNull();
  await expect(verifiedConvexOwner(request, deployment)).rejects.toThrow('backend unavailable');
});
