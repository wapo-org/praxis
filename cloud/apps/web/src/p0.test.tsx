// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiClient, PraxisApiClient } from './lib/api';
import {
  clearReplica,
  getReplicaIdentity,
  loadReplica,
  readReplicaSync,
  saveReplica,
  setReplicaIdentity,
  type LocalReplicaSnapshot,
} from './lib/idb';
import { getUnpinnedModels } from './lib/models';
import { parseRunEvent, subscribeRunEvents } from './lib/sse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
    clear: () => data.clear(),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearReplica();
  vi.unstubAllGlobals();
});

it('sends cookies without an invented bearer and notifies on 401', async () => {
  const client = new PraxisApiClient();
  const unauthorized = vi.fn();
  client.onUnauthorized = unauthorized;
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) => new Response('{}', { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(client.bootstrap()).rejects.toMatchObject({ status: 401 });
  expect(fetcher.mock.calls[0]![1].credentials).toBe('include');
  expect(
    (fetcher.mock.calls[0]![1].headers as Record<string, string>).Authorization,
  ).toBeUndefined();
  expect(unauthorized).toHaveBeenCalledOnce();
});
it('propagates unavailable routes instead of fabricating successful entities', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 404 }))),
  );
  const c = new PraxisApiClient();
  const operations = [
    () => c.checkModelKey(),
    () => c.connectModelKey({ method: 'paste', apiKey: 'sk-or-v1-x' }),
    () => c.listSkills(),
    () => c.createSkill({ name: 's', description: '', document: '' }),
    () => c.patchSkill('s', { name: 's', description: '', document: '' }),
    () => c.deleteSkill('s'),
    () => c.listSkillRegistries(),
    () => c.createSkillRegistry({ name: 'r', url: 'https://invalid.invalid' }),
    () => c.deleteSkillRegistry('r'),
    () => c.searchSkillRegistry('r'),
    () => c.installRegistrySkill('r', 's'),
    () => c.syncPull(),
    () => c.uploadAttachment(new File(['x'], 'x.txt')),
    () =>
      c.transcribeAudio({
        arrayBuffer: async () => new ArrayBuffer(1),
        type: 'audio/wav',
      } as Blob),
  ];
  for (const operation of operations)
    await expect(operation()).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('no longer available'),
    });
});
it('drops unknown and invalid stream payloads; accepts valid protocol events', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(parseRunEvent({ type: 'run.event', id: 1, event: { type: 'text.delta' } })).toBeNull();
  const event = {
    type: 'run.event',
    id: 1,
    runId: 'r',
    chatId: 'c',
    createdAt: new Date().toISOString(),
    event: { type: 'text.delta', blockId: 'b', text: 'hello' },
  };
  expect(parseRunEvent(event)).toEqual(event);
  expect(parseRunEvent({ ...event, event: { type: 'future.event' } })).toBeNull();
});
it('does not expose user A in user B or another API origin and clears on sign-out', async () => {
  localStorage.setItem('praxis-cloud-replica-v1', '{"secret":"old history"}');
  await setReplicaIdentity('https://a.example', 'A');
  const snapshot = {
    chats: [{ id: 'private-A' }],
    messagesByChat: { secret: [] },
  } as unknown as LocalReplicaSnapshot;
  const ownerA = getReplicaIdentity();
  await saveReplica(snapshot);
  expect(readReplicaSync()).toEqual(snapshot);
  expect(localStorage.getItem('praxis-cloud-replica-v1')).toBeNull();
  await setReplicaIdentity('https://a.example', 'B');
  await saveReplica(snapshot, ownerA); // A request completing after account switch must not write B.
  expect(await loadReplica()).toBeNull();
  expect(readReplicaSync()).toBeNull();
  await setReplicaIdentity('https://b.example', 'A');
  expect(await loadReplica()).toBeNull();
  await saveReplica(snapshot);
  await clearReplica();
  expect(readReplicaSync()).toBeNull();
});
it('filters pinned and favorite models out of the unpinned model list', () => {
  const unpinned = Array.from({ length: 35 }, () => ({ pinned: false }));
  const models = [{ pinned: true }, { favorite: true }, ...unpinned];
  expect(getUnpinnedModels(models)).toEqual(unpinned);
});
it('failed uploads and transcription surface errors without a fabricated attachment or text', async () => {
  const { PraxisStoreProvider, usePraxisStore } = await import('./state/store');
  vi.spyOn(apiClient, 'bootstrap').mockRejectedValue(new Error('Offline'));
  vi.spyOn(apiClient, 'uploadAttachment').mockRejectedValue(new Error('Upload unavailable'));
  vi.spyOn(apiClient, 'transcribeAudio').mockRejectedValue(new Error('Transcription unavailable'));
  let store!: ReturnType<typeof usePraxisStore>;
  function Probe() {
    store = usePraxisStore();
    return null;
  }
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <PraxisStoreProvider>
        <Probe />
      </PraxisStoreProvider>,
    ),
  );
  await act(async () => {
    await expect(store.uploadFiles([new File(['x'], 'x')])).rejects.toThrow('Upload unavailable');
  });
  expect(store.attachmentsById).toEqual({});
  expect(store.errorBanner).toBe('Upload unavailable');
  await act(async () => {
    await expect(store.transcribeAudioBlob(new Blob(['x']))).rejects.toThrow(
      'Transcription unavailable',
    );
  });
  expect(store.errorBanner).toBe('Transcription unavailable');
  await act(async () => root.unmount());
});

it('SSE 401 returns to sign-in and stops reconnecting', async () => {
  const client = new PraxisApiClient();
  const fetcher = vi.fn(async () => new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await new Promise<void>((resolve) => {
    client.onUnauthorized = resolve;
    subscribeRunEvents(client, 'r', 0, {
      onEvent: () => {
        throw new Error('Unexpected event');
      },
    });
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('validates CRLF SSE frames at the boundary before dispatch', async () => {
  const event = {
    type: 'run.event',
    id: 2,
    runId: 'r',
    chatId: 'c',
    createdAt: new Date().toISOString(),
    event: { type: 'text.delta', blockId: 'b', text: 'real' },
  };
  const invalid = { ...event, id: 1, event: { type: 'future.event' } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify(invalid)}\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
        ),
    ),
  );
  await new Promise<void>((resolve) => {
    const stop = subscribeRunEvents(new PraxisApiClient(), 'r', 0, {
      onEvent: (value) => {
        expect(value).toEqual(event);
        stop();
        resolve();
      },
    });
  });
});
