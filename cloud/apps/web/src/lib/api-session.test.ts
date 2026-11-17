import { afterEach, expect, it, vi } from 'vitest';
import { PraxisApiClient } from './api.js';
import { subscribeRunEvents } from './sse.js';
import { subscribeUserEvents } from './user-events.js';

afterEach(() => vi.unstubAllGlobals());
it('cancels an in-flight snapshot and blocks further work after the owner session ends', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
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

it('does not dispatch a queued request under a replacement owner after token acquisition', async () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  let deliverToken!: (token: string) => void;
  client.tokenProvider = () => new Promise(resolve => { deliverToken = resolve; });
  const fetcher = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const pending = client.bootstrap();
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  client.setSessionIdentity(null);
  client.setSessionIdentity('owner-b');
  deliverToken('old-owner-token');
  await cancelled;
  expect(fetcher).not.toHaveBeenCalled();
});

it('refreshing a token for the same owner does not cancel the current session scope', () => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
  const signal = client.getSessionSignal();
  client.setBearerToken('refreshed-token');
  client.setSessionIdentity('owner-a');
  expect(client.getSessionSignal()).toBe(signal);
  expect(signal.aborted).toBe(false);
});

it.each(['runs', 'users'])('aborts the %s event stream when the owner session ends', async kind => {
  const client = new PraxisApiClient();
  client.setSessionIdentity('owner-a');
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
