import { snapshotProgress } from './lib/toolProgress';
// @vitest-environment jsdom
import {
  CapabilitiesSchema,
  ToolActivitySchema,
  type Bootstrap,
  type Message,
  type Provider,
} from '@praxis/protocol';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentActivityView } from './components/chat/AgentActivityView';
import { AgentMessageView } from './components/chat/AgentMessageView';
import { UserBubble } from './components/chat/UserBubble';
import { SettingsSheet } from './components/screens/SettingsSheet';
import { AccountContext } from './lib/account';
import { apiClient } from './lib/api';
import { clearReplica, readReplicaSync, setReplicaIdentity } from './lib/idb';
import { safeLink, safeMessage } from './lib/links';
import { PraxisStoreProvider, usePraxisStore, type LiveRunState } from './state/store';
import type { PraxisState } from './state/usePraxisState';
import { useRunState } from './state/useRunState';
const now = new Date().toISOString();
let root: Root | undefined;
let container: HTMLDivElement;
const provider = (baseUrl: string): Provider => ({
  type: 'provider',
  id: 'external',
  name: 'External',
  flavor: 'openAIChat',
  baseUrl,
  maskedKey: '***',
  capabilities: CapabilitiesSchema.parse({}),
  updatedAt: now,
});
const bootstrap = (providers: Provider[] = []): Bootstrap => ({
  type: 'bootstrap',
  protocolVersion: 1,
  user: { type: 'user', id: 'A', name: 'User A' },
  chats: [],
  models: [],
  providers,
  connectors: [],
  skills: [],
  activeRuns: [],
  syncCursor: 'first',
  syncRoot: 'root',
  serverTime: now,
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  await clearReplica();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function storeWith(boot: Bootstrap) {
  vi.spyOn(apiClient, 'bootstrap').mockResolvedValue(boot);
  let store!: ReturnType<typeof usePraxisStore>;
  function Probe() {
    store = usePraxisStore();
    return null;
  }
  await act(async () =>
    root!.render(
      <PraxisStoreProvider>
        <Probe />
      </PraxisStoreProvider>,
    ),
  );
  return () => store;
}
it('persists the first bootstrap on / without a chat mutation', async () => {
  await setReplicaIdentity('https://api.example', 'A');
  const boot = bootstrap();
  await storeWith(boot);
  expect(readReplicaSync()).toMatchObject({
    bootstrap: boot,
    syncCursor: 'first',
    chats: [],
  });
});
it('blocks invalid provider URLs and requires consent for valid external URLs', async () => {
  const get = await storeWith(bootstrap([provider('javascript:alert(1)')]));
  const start = vi.spyOn(apiClient, 'startRun').mockRejectedValue(new Error('Should not send'));
  await act(async () => get().setSelectedModel('external', 'm'));
  await act(async () => get().sendMessage('Private'));
  expect(start).not.toHaveBeenCalled();
  expect(get().errorBanner).toContain('invalid server URL');
  vi.mocked(apiClient.bootstrap).mockResolvedValue(
    bootstrap([provider('https://provider.example/v1')]),
  );
  await act(async () => get().refreshAll());
  await act(async () => get().sendMessage('Private'));
  expect(get().pendingConsentPrompt?.host).toBe('provider.example');
  expect(start).not.toHaveBeenCalled();
});
it('accepts only http/https/mailto URLs in markdown and parsed message parts', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,evil',
    'vbscript:evil',
    'file:///secret',
  ]) {
    expect(safeLink(url)).toBeUndefined();
    const message = safeMessage({
      type: 'message',
      id: 'm',
      chatId: 'c',
      role: 'assistant',
      createdAt: now,
      updatedAt: now,
      parts: [{ type: 'text', url }],
    });
    expect(message.parts[0]?.url).toBeUndefined();
  }
  for (const url of ['https://example.com/', 'http://example.com/', 'mailto:a@example.com'])
    expect(safeLink(url)).toBe(url);
  const html = renderToStaticMarkup(
    <AgentMessageView text="[Unsafe](javascript:evil) [Safe](https://example.com/)" />,
  );
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com/"');
});
it('renders PDF and text document parts as named attachment chips', () => {
  const message: Message = {
    type: 'message',
    id: 'm',
    chatId: 'c',
    role: 'user',
    createdAt: now,
    updatedAt: now,
    parts: [
      { type: 'document', attachmentId: 'pdf' },
      { type: 'document', attachmentId: 'txt' },
    ],
  };
  const html = renderToStaticMarkup(
    <UserBubble
      message={message}
      attachmentsById={{
        pdf: {
          type: 'attachment',
          id: 'pdf',
          name: 'Report.pdf',
          mediaType: 'application/pdf',
          size: 1024,
          hiddenFromCode: false,
        },
        txt: {
          type: 'attachment',
          id: 'txt',
          name: 'Notes.txt',
          mediaType: 'text/plain',
          size: 40,
          hiddenFromCode: false,
        },
      }}
    />,
  );
  expect(html).toContain('Report.pdf');
  expect(html).toContain('Notes.txt');
  expect(html.match(/data-testid="document-attachment-chip"/g)).toHaveLength(2);
  expect(html).not.toContain('<img');
});
it('shows MCP status progress in the folded activity row', async () => {
  let events!: ReturnType<typeof useRunState>;
  function Probe() {
    const [runs, setRuns] = React.useState<Record<string, LiveRunState>>({});
    const ref = React.useRef(new Map());
    events = useRunState({
      setLiveRunsByChat: setRuns,
      setMessagesByChat: vi.fn(),
      activeRunUnsubMapRef: ref,
    } as unknown as PraxisState);
    return <AgentActivityView isRunning toolSteps={runs.c?.toolSteps ?? []} />;
  }
  await act(async () => root!.render(<Probe />));
  const base = {
    type: 'run.event' as const,
    id: 1,
    runId: 'r',
    chatId: 'c',
    createdAt: now,
  };
  const activity = ToolActivitySchema.parse({
    type: 'tool.activity',
    id: 'tool',
    name: 'fetch_docs',
    source: { type: 'mcp', serverId: 's', serverName: 'Docs' },
    presentation: {
      type: 'tool.presentation',
      category: 'integration',
      runningTitle: 'Reading docs',
      finishedTitle: 'Read docs',
    },
  });
  await act(async () =>
    events.handleRunEvent({
      ...base,
      event: { type: 'tool.started', activity },
    }),
  );
  await act(async () =>
    events.handleRunEvent({
      ...base,
      id: 2,
      event: {
        type: 'tool.progress',
        callId: 'tool',
        kind: 'status',
        text: 'Downloaded 2 of 8 pages',
      },
    }),
  );
  expect(container.textContent).toContain('Downloaded 2 of 8 pages');
});
it('uses the server title and never generates a client title PATCH', async () => {
  const get = await storeWith(bootstrap());
  const created = {
    type: 'chat' as const,
    id: 'c',
    title: 'New chat',
    mode: 'build' as const,
    pinned: false,
    connectorIds: [],
    disabledConnectorIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const create = vi.spyOn(apiClient, 'createChat').mockResolvedValue(created);
  const patch = vi.spyOn(apiClient, 'patchChat').mockResolvedValue(created);
  const read = vi
    .spyOn(apiClient, 'getChat')
    .mockResolvedValue({ ...created, title: 'Authoritative server title' });
  vi.spyOn(apiClient, 'startRun').mockResolvedValue({
    type: 'run',
    id: 'r',
    chatId: 'c',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastEventId: 0,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 401 })),
  );
  await act(async () => get().sendMessage('Client words must not become a title'));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'New chat' }));
  expect(patch).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith('c');
  expect(get().activeChat?.title).toBe('Authoritative server title');
});
it('places sign-out under Settings Account and keeps image/voice rows under Tools', async () => {
  vi.spyOn(apiClient, 'bootstrap').mockResolvedValue(bootstrap());
  const signOut = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root!.render(
      <AccountContext.Provider
        value={{
          userId: 'A',
          server: 'https://api.example',
          signOut,
          error: '',
          busy: false,
        }}
      >
        <PraxisStoreProvider>
          <SettingsSheet />
        </PraxisStoreProvider>
      </AccountContext.Provider>,
    ),
  );
  const account = [...container.querySelectorAll('section')].find((n) =>
    n.textContent?.includes('Server:'),
  )!;
  const button = [...account.querySelectorAll('button')].find((n) => n.textContent === 'Sign out')!;
  await act(async () => button.click());
  expect(signOut).toHaveBeenCalledOnce();
  const tools = [...container.querySelectorAll('section')].find(
    (n) => n.querySelector('h2')?.textContent === 'Tools',
  )!;
  expect(tools.textContent).toContain('Image reading model');
  expect(tools.textContent).toContain('Voice input');
  expect(container.querySelector('.account-sign-out')).toBeNull();
});

it('recovers the latest MCP status from a snapshot, including line payloads', () => {
  const progress: Parameters<typeof snapshotProgress>[0]['progress'] = [
    { kind: 'status', text: 'Starting' },
    { kind: 'output', text: 'detail' },
    { kind: 'status', lines: ['Downloaded', '8 pages'] },
  ];
  expect(snapshotProgress({ progress })).toEqual({
    progressLines: ['Starting', 'detail', 'Downloaded 8 pages'],
    statusText: 'Downloaded 8 pages',
  });
});
