import { afterEach, expect, it, vi } from 'vitest';
import { PraxisApiClient } from './api.js';
import { subscribeRunEvents } from './sse.js';
import { subscribeUserEvents } from './user-events.js';

afterEach(() => vi.unstubAllGlobals());
it('cancels an in-flight snapshot and blocks further work after the owner session ends', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    dispatched();
  }));
  vi.stubGlobal('fetch', fetcher);
  const pending = client.getRunSnapshot('run-a');
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  client.setSessionIdentity(null);
  await cancelled;
  await expect(client.getRunSnapshot('run-a')).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('does not dispatch a queued request with a replacement owner bearer token', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  const fetcher = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const pending = client.bootstrap();
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  client.setSessionIdentity(null);
  client.setSessionIdentity('owner-b');
  client.setBearerToken('owner-b-token');
  await cancelled;
  expect(fetcher).not.toHaveBeenCalled();
});

it('refreshing a token for the same owner does not cancel the current session scope', () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  const signal = client.getSessionSignal();
  client.setBearerToken('refreshed-token');
  client.setSessionIdentity('owner-a');
  expect(client.getBearerToken()).toBe('refreshed-token');
  expect(client.getSessionSignal()).toBe(signal);
  expect(signal.aborted).toBe(false);
});

it.each(['runs', 'users'])('aborts the %s event stream when the owner session ends', async kind => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  let dispatched!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { dispatched = resolve; });
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    dispatched(init.signal!);
  }));
  vi.stubGlobal('fetch', fetcher);
  const stop = kind === 'runs'
    ? subscribeRunEvents(client, 'run-a', 0, { onEvent: vi.fn() })
    : subscribeUserEvents(client, 0, vi.fn());
  const signal = await started;
  client.setSessionIdentity(null);
  expect(signal.aborted).toBe(true);
  stop();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('ignores a stale unauthorized response after another owner has signed in', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  let deliverResponse!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { deliverResponse = resolve; })));
  const unauthorized = vi.fn();
  client.onUnauthorized = unauthorized;
  const pending = client.bootstrap();
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  client.setSessionIdentity(null);
  client.setSessionIdentity('owner-b');
  client.setBearerToken('owner-b-token');
  deliverResponse(new Response('{}', { status: 401 }));
  await cancelled;
  expect(unauthorized).not.toHaveBeenCalled();
  expect(client.getBearerToken()).toBe('owner-b-token');
});

function stubUpload(transfer: (init: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/uploads')) return new Response(JSON.stringify({ type: 'upload.url', uploadUrl: '/v1/uploads/blob', expiresAt: '' }));
    if (url.endsWith('/v1/uploads/blob')) return transfer(init);
    return new Response(JSON.stringify({ id: 'att-a' }));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function bearers(fetcher: ReturnType<typeof stubUpload>): string[] {
  return fetcher.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization ?? '');
}

it('binds an upload and its completion to the owner session that started it', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  let transferring!: () => void;
  const started = new Promise<void>(resolve => { transferring = resolve; });
  const fetcher = stubUpload(init => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    transferring();
  }));
  const pending = client.uploadAttachment(new File(['a'], 'a.txt', { type: 'text/plain' }));
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  client.setSessionIdentity(null);
  client.setSessionIdentity('owner-b');
  client.setBearerToken('owner-b-token');
  await cancelled;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(bearers(fetcher)).toEqual(['Bearer owner-a-token', 'Bearer owner-a-token']);
});

it('ignores a delayed upload 401 after another owner has signed in', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  let deliver!: (response: Response) => void;
  const started = new Promise<void>(resolve => {
    stubUpload(() => new Promise<Response>(settle => { deliver = settle; resolve(); }));
  });
  const unauthorized = vi.fn();
  client.onUnauthorized = unauthorized;
  const pending = client.uploadAttachment(new File(['a'], 'a.txt', { type: 'text/plain' }));
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  client.setSessionIdentity(null);
  client.setSessionIdentity('owner-b');
  client.setBearerToken('owner-b-token');
  deliver(new Response('{}', { status: 401 }));
  await cancelled;
  expect(unauthorized).not.toHaveBeenCalled();
  expect(client.getBearerToken()).toBe('owner-b-token');
});

it('completes an upload with the token captured at entry when the same owner refreshes it', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  client.setBearerToken('owner-a-token');
  const fetcher = stubUpload(async () => {
    client.setBearerToken('owner-a-refreshed');
    client.setSessionIdentity('owner-a');
    return new Response(JSON.stringify({ storageId: 'blob-a' }));
  });
  await expect(client.uploadAttachment(new File(['a'], 'a.txt', { type: 'text/plain' }))).resolves.toMatchObject({ id: 'att-a' });
  expect(bearers(fetcher)).toEqual(['Bearer owner-a-token', 'Bearer owner-a-token', 'Bearer owner-a-token']);
});
