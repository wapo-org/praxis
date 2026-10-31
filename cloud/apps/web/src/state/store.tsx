import type { Capabilities } from '@praxis/protocol';
import { pathForSheet } from '../lib/navigation';
import { useMediaActions } from './useMediaActions';
import React from 'react';
import type {
  Approval,
  Attachment,
  Chat,
  Connector,
  Message,
  Model,
  Provider,
  Run,
  RunEvent,
  RunSnapshot,
  Skill,
  Usage,
} from '@praxis/protocol';
import type { ThemeMode, ResolvedTheme } from '@praxis/glass';
import {
  apiClient,
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
  type ToolActivity,
  type ToolCompletion,
  type ToolSpec,
} from '../lib/api';
import { getReplicaIdentity, readReplicaSync, saveReplica, type LocalReplicaSnapshot } from '../lib/idb';
import { subscribeRunEvents } from '../lib/sse';

export interface ActiveToolStep {
  callId: string;
  activity: ToolActivity;
  argumentsJson: string;
  running: boolean;
  progressLines: string[];
  completion?: ToolCompletion;
}

export interface ActiveElicitation {
  id: string;
  message: string;
  schema: Record<string, unknown>;
  callId?: string;
  connectorId?: string;
  connectorName?: string;
  mode?: 'form' | 'url';
  url?: string;
}

export interface LiveRunState {
  run: Run;
  lastEventId: number;
  textBlocks: Array<{ id: string; text: string; finished: boolean }>;
  reasoningBlocks: Array<{ id: string; text: string; finished: boolean }>;
  toolSteps: ActiveToolStep[];
  pendingApprovals: Approval[];
  pendingElicitations: ActiveElicitation[];
  visionActivities: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    attachmentId: string;
    modelId?: string;
    question?: string;
    answer?: string;
  }>;
  compactions: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    summary?: string;
  }>;
  usage?: Usage;
}

export type ActiveSheet =
  | null
  | 'history'
  | 'settings'
  | 'providers'
  | 'provider-editor'
  | 'connectors'
  | 'connector-add-url'
  | 'connector-paste-config'
  | 'connector-registry'
  | 'skills'
  | 'skill-import'
  | 'skill-browser'
  | 'image-reader'
  | 'voice-settings'
  | 'consents';

export interface PendingConsentPrompt {
  host: string;
  purpose: 'chat' | 'vision' | 'voice' | 'connector';
  description: string;
  onAllow: () => void;
  onCancel?: () => void;
}

export interface PraxisStoreContextValue {
  // Hydration & Perf
  hydrated: boolean;
  syncing: boolean;
  errorBanner: string | null;
  clearErrorBanner: () => void;

  // Theme
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;

  // Navigation & Sheets
  activeSheet: ActiveSheet;
  setActiveSheet: (sheet: ActiveSheet) => void;
  restoreRoute: (chatId: string | null, sheet: ActiveSheet, providerId?: string | null) => void;
  startNewConversation: () => void;
  editingProviderId: string | null;
  setEditingProviderId: (id: string | null) => void;
  desktopSidebarOpen: boolean;
  setDesktopSidebarOpen: (open: boolean) => void;
  plusTrayOpen: boolean;
  setPlusTrayOpen: (open: boolean) => void;
  inlineModelSearchActive: boolean;
  setInlineModelSearchActive: (active: boolean) => void;

  // Core Entities
  chats: Chat[];
  activeChatId: string | null;
  activeChat: Chat | null;
  messagesByChat: Record<string, Message[]>;
  activeMessages: Message[];
  providers: Provider[];
  models: Model[];
  connectors: Connector[];
  connectorTools: Record<string, ToolSpec[]>;
  skills: Skill[];
  registries: Registry[];
  registryEntries: Record<string, RegistryEntry[]>;
  consents: Consent[];
  preferences: Preferences | null;
  attachmentsById: Record<string, Attachment>;

  // Selected Composer Controls
  selectedProviderId: string;
  selectedModelId: string;
  webSearch: boolean;
  setWebSearch: (value: boolean) => void;
  cacheModels: (items: Model[]) => void;
  selectedEffort: string;
  selectedMode: 'ask' | 'plan' | 'build' | 'auto';
  setSelectedModel: (providerId: string, modelId: string) => void;
  setSelectedEffort: (effort: string) => void;
  setSelectedMode: (mode: 'ask' | 'plan' | 'build' | 'auto') => void;

  // Live Run State per Chat
  liveRunsByChat: Record<string, LiveRunState>;
  activeLiveRun: LiveRunState | null;

  // Consent Prompt
  pendingConsentPrompt: PendingConsentPrompt | null;
  setPendingConsentPrompt: (prompt: PendingConsentPrompt | null) => void;

  // Actions
  selectChat: (chatId: string) => Promise<void>;
  createNewChat: (title?: string) => Promise<Chat>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  togglePinChat: (chatId: string) => Promise<void>;
  deleteChats: (chatIds: string[]) => Promise<void>;
  toggleChatConnector: (chatId: string, connectorId: string, enabled: boolean) => Promise<void>;

  sendMessage: (
    text: string,
    options?: {
      attachmentIds?: string[];
      script?:
        | 'text'
        | 'tools'
        | 'approval'
        | 'nestedApproval'
        | 'elicitation'
        | 'error'
        | 'long'
        | 'compaction'
        | 'vision';
    },
  ) => Promise<void>;
  cancelActiveRun: () => Promise<void>;
  resolveApproval: (
    runId: string,
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ) => Promise<void>;
  resolveElicitation: (
    runId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => Promise<void>;

  toggleModelPin: (providerId: string, modelId: string, pinned: boolean) => Promise<void>;
  saveProvider: (
    input: {
      id?: string;
      name: string;
      flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
      baseUrl: string;
      defaultModel?: string;
      apiKey?: string;
      capabilities?: Capabilities;
      extraHeaders?: Record<string, string>;
    },
  ) => Promise<Provider>;
  removeProvider: (providerId: string) => Promise<void>;
  refreshModelsForProvider: (providerId: string) => Promise<Model[]>;

  createConnector: (input: {
    name: string;
    url: string;
    transport?: 'streamableHttp' | 'sse';
    token?: string;
  }) => Promise<Connector>;
  updateConnector: (
    connectorId: string,
    patch: { enabled?: boolean; trusted?: boolean; name?: string; url?: string },
  ) => Promise<void>;
  removeConnector: (connectorId: string) => Promise<void>;
  loadConnectorTools: (connectorId: string) => Promise<ToolSpec[]>;
  setConnectorToolEnabled: (
    connectorId: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;

  saveSkill: (input: {
    id?: string;
    name: string;
    description: string;
    document: string;
    enabled?: boolean;
  }) => Promise<Skill>;
  removeSkill: (skillId: string) => Promise<void>;
  addSkillRegistry: (name: string, url: string) => Promise<Registry>;
  removeSkillRegistry: (registryId: string) => Promise<void>;
  searchRegistry: (registryId: string, q?: string) => Promise<RegistryEntry[]>;
  installSkillFromRegistry: (registryId: string, skillEntryId: string) => Promise<Skill>;

  grantConsent: (host: string, allowed: boolean) => Promise<void>;
  updatePreferences: (input: {
    vision?: { providerId?: string; modelId?: string; enabled?: boolean };
    voice?: { model?: string; language?: string; apiKey?: string };
  }) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<Attachment[]>;
  transcribeAudioBlob: (blob: Blob) => Promise<string>;
  refreshAll: () => Promise<void>;
}

const PraxisStoreContext = React.createContext<PraxisStoreContextValue | null>(null);

export function usePraxisStore(): PraxisStoreContextValue {
  const ctx = React.useContext(PraxisStoreContext);
  if (!ctx) {
    throw new Error('usePraxisStore must be used within <PraxisStoreProvider>');
  }
  return ctx;
}

export function PraxisStoreProvider({ children, onNavigate }: { children: React.ReactNode; onNavigate?: (path: string) => void }) {
  const replicaKey = React.useRef(getReplicaIdentity());
  const initialCache = React.useMemo(() => readReplicaSync(), []);

  const [hydrated, setHydrated] = React.useState<boolean>(Boolean(initialCache));
  const [syncing, setSyncing] = React.useState<boolean>(false);
  const [errorBanner, setErrorBanner] = React.useState<string | null>(null);

  const [themeMode, setThemeModeState] = React.useState<ThemeMode>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('praxis-theme') as ThemeMode | null;
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    return 'light';
  });

  const setThemeMode = React.useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('praxis-theme', mode);
      } catch {}
    }
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const nextResolved: ResolvedTheme =
        mode === 'system'
          ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : mode;
      setResolvedTheme(nextResolved);
      document.documentElement.setAttribute('data-theme', nextResolved);
    }
  }, []);

  React.useEffect(() => {
    setThemeMode(themeMode);
  }, [themeMode, setThemeMode]);

  // Sheets & Layout
  const [activeSheet, setActiveSheetState] = React.useState<ActiveSheet>(null);
  const [editingProviderId, setEditingProviderIdState] = React.useState<string | null>(null);
  const providerIdRef = React.useRef(editingProviderId);
  const setEditingProviderId = (id: string | null) => { providerIdRef.current = id; setEditingProviderIdState(id); };
  const [desktopSidebarOpen, setDesktopSidebarOpen] = React.useState<boolean>(false);
  const [plusTrayOpen, setPlusTrayOpen] = React.useState<boolean>(false);
  const [inlineModelSearchActive, setInlineModelSearchActive] = React.useState<boolean>(false);

  // Entities initialized from synchronous replica cache first (<16ms paint)
  const [chats, setChats] = React.useState<Chat[]>(() => initialCache?.chats ?? []);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(
    null,
  );
  const [messagesByChat, setMessagesByChat] = React.useState<Record<string, Message[]>>(
    () => initialCache?.messagesByChat ?? {},
  );
  const [providers, setProviders] = React.useState<Provider[]>(() => initialCache?.providers ?? []);
  const [models, setModels] = React.useState<Model[]>(
    () => (initialCache?.models?.length ? initialCache.models : []),
  );
  const [connectors, setConnectors] = React.useState<Connector[]>(
    () => initialCache?.connectors ?? [],
  );
  const [connectorTools, setConnectorTools] = React.useState<Record<string, ToolSpec[]>>({});
  const [skills, setSkills] = React.useState<Skill[]>(() => initialCache?.skills ?? []);
  const [registries, setRegistries] = React.useState<Registry[]>(
    () => initialCache?.registries ?? [],
  );
  const [registryEntries, setRegistryEntries] = React.useState<Record<string, RegistryEntry[]>>({});
  const [consents, setConsents] = React.useState<Consent[]>(() => initialCache?.consents ?? []);
  const [preferences, setPreferences] = React.useState<Preferences | null>(
    () => initialCache?.preferences ?? null,
  );
  const [attachmentsById, setAttachmentsById] = React.useState<Record<string, Attachment>>({});
  const [syncCursor, setSyncCursor] = React.useState<string>(
    () => initialCache?.syncCursor ?? '0',
  );

  // Selected composer controls
  const [selectedProviderId, setSelectedProviderId] = React.useState<string>('');
  const [selectedModelId, setSelectedModelId] = React.useState<string>('');
  const [webSearch, setWebSearch] = React.useState(false);
  const cacheModels = React.useCallback((items: Model[]) => setModels(prev => [...prev.filter(p => !items.some(m => m.providerId === p.providerId && m.id === p.id)), ...items]), []);
  const [selectedEffort, setSelectedEffort] = React.useState<string>('medium');
  const [selectedMode, setSelectedMode] = React.useState<'ask' | 'plan' | 'build' | 'auto'>('build');

  const [liveRunsByChat, setLiveRunsByChat] = React.useState<Record<string, LiveRunState>>({});
  const [pendingConsentPrompt, setPendingConsentPrompt] =
    React.useState<PendingConsentPrompt | null>(null);

  const setActiveSheet = (sheet: ActiveSheet) => {
    setActiveSheetState(sheet);
    onNavigate?.(pathForSheet(sheet, activeChatId, providerIdRef.current));
  };
  const startNewConversation = () => { setActiveChatId(null); setActiveSheetState(null); setPlusTrayOpen(false); onNavigate?.('/'); };
  const restoreRoute = (chatId: string | null, sheet: ActiveSheet, providerId?: string | null) => {
    setActiveSheetState(sheet);
    if (providerId !== undefined) setEditingProviderId(providerId);
    if (sheet) return;
    setActiveChatId(chatId);
    if (chatId) void apiClient.listMessages(chatId).then(page => {
      setMessagesByChat(prev => ({ ...prev, [chatId]: page.items }));
    }).catch(err => setErrorBanner(err instanceof Error ? err.message : 'Unable to open chat'));
  };
  const activeRunUnsubMapRef = React.useRef<Map<string, () => void>>(new Map());

  // Mark first paint on initial mount
  React.useLayoutEffect(() => {
    if (typeof performance !== 'undefined') {
      performance.mark('praxis:first-paint');
      try {
        performance.measure('praxis:boot-to-paint', 'praxis:boot-start', 'praxis:first-paint');
      } catch {}
    }
  }, []);

  // Persist replica on state changes
  const persistState = React.useCallback(
    (nextPartial?: Partial<LocalReplicaSnapshot>) => {
      const snap: LocalReplicaSnapshot = {
        chats,
        messagesByChat,
        providers,
        models,
        connectors,
        skills,
        consents,
        registries,
        preferences: preferences ?? undefined,
        syncCursor,
        updatedAt: Date.now(),
        ...nextPartial,
      };
      void saveReplica(snap, replicaKey.current);
    },
    [
      chats,
      messagesByChat,
      providers,
      models,
      connectors,
      skills,
      consents,
      registries,
      preferences,
      syncCursor,
    ],
  );

  const applySnapshotToLiveRun = React.useCallback((snapshot: RunSnapshot) => {
    setLiveRunsByChat((prev) => ({
      ...prev,
      [snapshot.run.chatId]: {
        run: snapshot.run,
        lastEventId: snapshot.lastEventId,
        textBlocks: snapshot.blocks
          .filter((b) => b.type === 'text')
          .map((b) => ({ id: b.id, text: b.text, finished: b.finished })),
        reasoningBlocks: snapshot.blocks
          .filter((b) => b.type === 'reasoning')
          .map((b) => ({ id: b.id, text: b.text, finished: b.finished })),
        toolSteps: snapshot.tools.map((t) => ({
          callId: t.activity.id,
          activity: t.activity,
          argumentsJson: t.argumentsJson,
          running: t.running,
          progressLines: [],
          completion: t.completion,
        })),
        pendingApprovals: snapshot.pendingApprovals,
        pendingElicitations: snapshot.pendingElicitations as ActiveElicitation[],
        visionActivities: [],
        compactions: [],
        usage: snapshot.usage,
      },
    }));
    if (snapshot.messages.length > 0) {
      setMessagesByChat((prev) => {
        const existing = prev[snapshot.run.chatId] ?? [];
        const byId = new Map<string, Message>();
        for (const m of existing) byId.set(m.id, m);
        for (const m of snapshot.messages) byId.set(m.id, m);
        const merged = Array.from(byId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return { ...prev, [snapshot.run.chatId]: merged };
      });
    }
  }, []);

  const handleRunEvent = React.useCallback((envelope: RunEvent) => {
    const { chatId, runId, id: eventId, event } = envelope;

    if (event.type === 'messages.committed') {
      setMessagesByChat((prev) => {
        const existing = prev[chatId] ?? [];
        const byId = new Map<string, Message>();
        for (const m of existing) {
          // Replace optimistic turn if clientTurnId matches
          const committedMatch = event.messages.find(
            (cm) => cm.clientTurnId && cm.clientTurnId === m.clientTurnId && cm.role === m.role,
          );
          if (!committedMatch) {
            byId.set(m.id, m);
          }
        }
        for (const m of event.messages) {
          byId.set(m.id, m);
        }
        const merged = Array.from(byId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return { ...prev, [chatId]: merged };
      });
    }

    setLiveRunsByChat((prev) => {
      const current: LiveRunState = prev[chatId] ?? {
        run: {
          type: 'run',
          id: runId,
          chatId,
          status: 'running',
          createdAt: envelope.createdAt,
          updatedAt: envelope.createdAt,
          lastEventId: eventId,
        },
        lastEventId: 0,
        textBlocks: [],
        reasoningBlocks: [],
        toolSteps: [],
        pendingApprovals: [],
        pendingElicitations: [],
        visionActivities: [],
        compactions: [],
      };

      const next: LiveRunState = {
        ...current,
        lastEventId: Math.max(current.lastEventId, eventId),
        run: {
          ...current.run,
          lastEventId: Math.max(current.run.lastEventId, eventId),
          updatedAt: envelope.createdAt,
        },
        textBlocks: [...current.textBlocks],
        reasoningBlocks: [...current.reasoningBlocks],
        toolSteps: [...current.toolSteps],
        pendingApprovals: [...current.pendingApprovals],
        pendingElicitations: [...current.pendingElicitations],
        visionActivities: [...current.visionActivities],
        compactions: [...current.compactions],
      };

      switch (event.type) {
        case 'run.started':
          next.run.status = 'running';
          break;
        case 'text.delta': {
          const idx = next.textBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            const prevBlock = next.textBlocks[idx]!;
            next.textBlocks[idx] = { ...prevBlock, text: prevBlock.text + event.text };
          } else {
            next.textBlocks.push({ id: event.blockId, text: event.text, finished: false });
          }
          break;
        }
        case 'text.finished': {
          const idx = next.textBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            next.textBlocks[idx] = { ...next.textBlocks[idx]!, finished: true };
          }
          break;
        }
        case 'reasoning.delta': {
          const idx = next.reasoningBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            const prevBlock = next.reasoningBlocks[idx]!;
            next.reasoningBlocks[idx] = { ...prevBlock, text: prevBlock.text + event.text };
          } else {
            next.reasoningBlocks.push({ id: event.blockId, text: event.text, finished: false });
          }
          break;
        }
        case 'reasoning.finished': {
          const idx = next.reasoningBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            next.reasoningBlocks[idx] = { ...next.reasoningBlocks[idx]!, finished: true };
          }
          break;
        }
        case 'tool.started':
        case 'tool.ready': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.activity.id);
          const argsStr =
            event.activity.arguments !== undefined
              ? JSON.stringify(event.activity.arguments, null, 2)
              : '';
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            next.toolSteps[idx] = {
              ...existing,
              activity: event.activity,
              argumentsJson: argsStr || existing.argumentsJson,
            };
          } else {
            next.toolSteps.push({
              callId: event.activity.id,
              activity: event.activity,
              argumentsJson: argsStr,
              running: event.type === 'tool.started',
              progressLines: [],
            });
          }
          break;
        }
        case 'tool.arguments.delta': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            next.toolSteps[idx] = {
              ...existing,
              argumentsJson: existing.argumentsJson + event.json,
            };
          }
          break;
        }
        case 'tool.running': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            next.toolSteps[idx] = { ...next.toolSteps[idx]!, running: true };
          }
          break;
        }
        case 'tool.progress': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            const lines = [...existing.progressLines];
            if (event.text) lines.push(event.text);
            if (event.lines) lines.push(...event.lines);
            next.toolSteps[idx] = { ...existing, progressLines: lines };
          }
          break;
        }
        case 'tool.finished': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            next.toolSteps[idx] = {
              ...next.toolSteps[idx]!,
              running: false,
              completion: event.completion,
            };
          }
          break;
        }
        case 'approval.requested':
          next.run.status = 'awaitingApproval';
          if (!next.pendingApprovals.some((a) => a.id === event.approval.id)) {
            next.pendingApprovals.push(event.approval);
          }
          break;
        case 'approval.resolved':
          next.run.status = 'running';
          next.pendingApprovals = next.pendingApprovals.filter((a) => a.id !== event.approvalId);
          break;
        case 'elicitation.requested':
          next.run.status = 'awaitingElicitation';
          if (!next.pendingElicitations.some((e) => e.id === event.elicitation.id)) {
            next.pendingElicitations.push(event.elicitation as ActiveElicitation);
          }
          break;
        case 'elicitation.resolved':
          next.run.status = 'running';
          next.pendingElicitations = next.pendingElicitations.filter(
            (e) => e.id !== event.elicitationId,
          );
          break;
        case 'vision.activity': {
          const idx = next.visionActivities.findIndex((v) => v.id === event.id);
          const entry = {
            id: event.id,
            phase: event.phase,
            attachmentId: event.attachmentId,
            modelId: event.modelId,
            question: event.question,
            answer: event.answer,
          };
          if (idx >= 0) next.visionActivities[idx] = entry;
          else next.visionActivities.push(entry);
          break;
        }
        case 'compaction': {
          const idx = next.compactions.findIndex((c) => c.id === event.id);
          const entry = { id: event.id, phase: event.phase, summary: event.summary };
          if (idx >= 0) next.compactions[idx] = entry;
          else next.compactions.push(entry);
          break;
        }
        case 'usage':
          next.usage = event.usage;
          break;
        case 'run.finished':
          next.run.status =
            event.outcome === 'failed'
              ? 'failed'
              : event.outcome === 'cancelled'
                ? 'cancelled'
                : 'completed';
          next.run.outcome = event.outcome;
          if (event.message && event.outcome === 'failed') {
            next.run.error = event.message;
          }
          break;
      }

      return { ...prev, [chatId]: next };
    });
  }, []);

  const attachRunStream = React.useCallback(
    (run: Run, afterEventId = 0) => {
      const existingUnsub = activeRunUnsubMapRef.current.get(run.id);
      if (existingUnsub) existingUnsub();

      const unsub = subscribeRunEvents(apiClient, run.id, afterEventId, {
        onEvent: handleRunEvent,
        onSnapshotRecovered: applySnapshotToLiveRun,
        onComplete: () => {
          activeRunUnsubMapRef.current.delete(run.id);
          void apiClient
            .listMessages(run.chatId)
            .then((page) => {
              setMessagesByChat((prev) => ({ ...prev, [run.chatId]: page.items }));
            })
            .catch(() => {});
        },
      });
      activeRunUnsubMapRef.current.set(run.id, unsub);
    },
    [handleRunEvent, applySnapshotToLiveRun],
  );

  const refreshAll = React.useCallback(async () => {
    setSyncing(true);
    try {
      const boot = await apiClient.bootstrap();
      setChats(boot.chats);
      setProviders(boot.providers);
      setModels(boot.models);
      if (!selectedModelId && boot.models[0]) {
        setSelectedModelId(boot.models[0].id);
        setSelectedProviderId(boot.models[0].providerId);
      }
      setConnectors(boot.connectors);
      setSkills(boot.skills);
      if (boot.consents) setConsents(boot.consents);
      if (boot.registries) setRegistries(boot.registries);
      if (boot.preferences) setPreferences(boot.preferences);
      setSyncCursor(boot.syncCursor);

      const firstChatId = activeChatId;
      if (firstChatId && !activeChatId) {
        setActiveChatId(firstChatId);
      }
      if (firstChatId) {
        const msgPage = await apiClient.listMessages(firstChatId);
        setMessagesByChat((prev) => {
          const next = { ...prev, [firstChatId]: msgPage.items };
          void saveReplica({
            bootstrap: boot,
            chats: boot.chats,
            messagesByChat: next,
            providers: boot.providers,
            models: boot.models.length ? boot.models : [],
            connectors: boot.connectors,
            skills: boot.skills,
            consents: boot.consents ?? [],
            registries: boot.registries ?? [],
            preferences: boot.preferences,
            syncCursor: boot.syncCursor,
            updatedAt: Date.now(),
          }, replicaKey.current);
          return next;
        });
      }

      // Re-attach any active runs reported in bootstrap
      for (const run of boot.activeRuns) {
        try {
          const snap = await apiClient.getRunSnapshot(run.id);
          applySnapshotToLiveRun(snap);
          attachRunStream(run, snap.lastEventId);
        } catch {
          attachRunStream(run, 0);
        }
      }
      setHydrated(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to load account');
      setHydrated(true);
    } finally {
      setSyncing(false);
    }
  }, [activeChatId, applySnapshotToLiveRun, attachRunStream]);

  const routeChat = chats.find(value => value.id === activeChatId);
  React.useEffect(() => {
    if (routeChat?.providerId) setSelectedProviderId(routeChat.providerId);
    if (routeChat?.modelId) setSelectedModelId(routeChat.modelId);
  }, [activeChatId, routeChat?.providerId, routeChat?.modelId]);
  React.useEffect(() => {
    if (routeChat?.mode) setSelectedMode(routeChat.mode);
  }, [activeChatId, routeChat?.mode]);
  React.useEffect(() => {
    if (routeChat?.effort) setSelectedEffort(routeChat.effort);
  }, [activeChatId, routeChat?.effort]);

  // The account gate loads only the verified user’s replica before mounting.
  React.useEffect(() => {
    void refreshAll();
  }, []);

  const selectChat = React.useCallback(
    async (chatId: string) => {
      if (typeof performance !== 'undefined') {
        performance.mark('praxis:chat-switch-start');
      }
      setActiveChatId(chatId);
      onNavigate?.(`/c/${encodeURIComponent(chatId)}`);
      const chat = chats.find((c) => c.id === chatId);
      if (chat?.providerId && chat?.modelId) {
        setSelectedProviderId(chat.providerId);
        setSelectedModelId(chat.modelId);
      }
      if (chat?.effort) setSelectedEffort(chat.effort);
      if (chat?.mode) setSelectedMode(chat.mode);

      requestAnimationFrame(() => {
        if (typeof performance !== 'undefined') {
          performance.mark('praxis:chat-switch-end');
          try {
            performance.measure(
              'praxis:chat-switch',
              'praxis:chat-switch-start',
              'praxis:chat-switch-end',
            );
          } catch {}
        }
      });

      try {
        const page = await apiClient.listMessages(chatId);
        setMessagesByChat((prev) => {
          const next = { ...prev, [chatId]: page.items };
          persistState({ messagesByChat: next });
          return next;
        });
      } catch (err) { setErrorBanner(err instanceof Error ? err.message : 'Unable to load messages'); }
    },
    [chats, persistState],
  );

  const createNewChat = React.useCallback(
    async (title = 'New chat'): Promise<Chat> => {
      const created = await apiClient.createChat({
        title,
        mode: selectedMode,
        providerId: selectedProviderId,
        modelId: selectedModelId,
        effort: selectedEffort,
      });
      setChats((prev) => {
        const next = [created, ...prev.filter((c) => c.id !== created.id)];
        persistState({ chats: next });
        return next;
      });
      setActiveChatId(created.id);
      onNavigate?.(`/c/${encodeURIComponent(created.id)}`);
      setMessagesByChat((prev) => ({ ...prev, [created.id]: [] }));
      return created;
    },
    [selectedMode, selectedProviderId, selectedModelId, selectedEffort, persistState],
  );

  const renameChat = React.useCallback(
    async (chatId: string, title: string) => {
      const updated = await apiClient.patchChat(chatId, { title });
      setChats((prev) => {
        const next = prev.map((c) => (c.id === chatId ? updated : c));
        persistState({ chats: next });
        return next;
      });
    },
    [persistState],
  );

  const togglePinChat = React.useCallback(
    async (chatId: string) => {
      const target = chats.find((c) => c.id === chatId);
      if (!target) return;
      const updated = await apiClient.patchChat(chatId, { pinned: !target.pinned });
      setChats((prev) => {
        const next = prev
          .map((c) => (c.id === chatId ? updated : c))
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
          );
        persistState({ chats: next });
        return next;
      });
    },
    [chats, persistState],
  );

  const deleteChats = React.useCallback(
    async (chatIds: string[]) => {
      await Promise.all(chatIds.map((id) => apiClient.deleteChat(id)));
      setChats((prev) => {
        const remaining = prev.filter((c) => !chatIds.includes(c.id));
        if (activeChatId && chatIds.includes(activeChatId)) {
          setActiveChatId(remaining[0]?.id ?? null);
        }
        persistState({ chats: remaining });
        return remaining;
      });
    },
    [activeChatId, persistState],
  );

  const toggleChatConnector = React.useCallback(
    async (chatId: string, connectorId: string, enabled: boolean) => {
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) return;
      const disabledSet = new Set(chat.disabledConnectorIds ?? []);
      if (enabled) disabledSet.delete(connectorId);
      else disabledSet.add(connectorId);
      const updated = await apiClient.patchChat(chatId, {
        disabledConnectorIds: Array.from(disabledSet),
      });
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    },
    [chats],
  );

  const executeSendMessage = React.useCallback(
    async (
      text: string,
      options?: {
        attachmentIds?: string[];
        script?:
          | 'text'
          | 'tools'
          | 'approval'
          | 'nestedApproval'
          | 'elicitation'
          | 'error'
          | 'long'
          | 'compaction'
          | 'vision';
      },
    ) => {
      setErrorBanner(null);
      let targetChatId = activeChatId;
      if (!targetChatId) {
        const created = await createNewChat(text.slice(0, 48) || 'New chat');
        targetChatId = created.id;
      }

      const clientTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();
      const optimisticUserMsg: Message = {
        type: 'message',
        id: `optimistic-${clientTurnId}`,
        chatId: targetChatId,
        clientTurnId,
        role: 'user',
        parts: [
          { type: 'text', text },
          ...(options?.attachmentIds ?? []).map((attachmentId) => ({
            type: 'image' as const,
            attachmentId,
          })),
        ],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      setMessagesByChat((prev) => ({
        ...prev,
        [targetChatId!]: [...(prev[targetChatId!] ?? []), optimisticUserMsg],
      }));

      // Auto-title 'New chat' on first user message
      const currentChat = chats.find((c) => c.id === targetChatId);
      if (currentChat && (currentChat.title === 'New chat' || !currentChat.title.trim()) && text.trim()) {
        void renameChat(targetChatId, text.trim().slice(0, 56));
      }

      // Infer script in local mode from prompt keywords if not explicitly provided
      let inferredScript = options?.script;
      if (!inferredScript && selectedProviderId === 'scripted') {
        const lower = text.toLowerCase();
        if (lower.includes('nested approval')) inferredScript = 'nestedApproval';
        else if (lower.includes('approval') || lower.includes('approve')) inferredScript = 'approval';
        else if (lower.includes('elicitation') || lower.includes('clarify'))
          inferredScript = 'elicitation';
        else if (lower.includes('tool') || lower.includes('table') || lower.includes('search'))
          inferredScript = 'tools';
        else if (lower.includes('vision') || (options?.attachmentIds?.length ?? 0) > 0)
          inferredScript = 'vision';
        else if (lower.includes('compact')) inferredScript = 'compaction';
        else if (lower.includes('error')) inferredScript = 'error';
      }

      try {
        if (typeof performance !== 'undefined') {
          performance.mark('praxis:run-start');
        }
        const run = await apiClient.startRun({
          chatId: targetChatId,
          text,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          mode: selectedMode,
          effort: selectedEffort,
          webSearch: webSearch && !!models.find(m => m.id === selectedModelId && m.providerId === selectedProviderId)?.capabilities.serverWebSearch,
          attachmentIds: options?.attachmentIds ?? [],
          clientTurnId,
          idempotencyKey: clientTurnId,
          script: inferredScript,
        });

        setLiveRunsByChat((prev) => ({
          ...prev,
          [targetChatId!]: {
            run,
            lastEventId: 0,
            textBlocks: [],
            reasoningBlocks: [],
            toolSteps: [],
            pendingApprovals: [],
            pendingElicitations: [],
            visionActivities: [],
            compactions: [],
          },
        }));

        attachRunStream(run, 0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to start run';
        setErrorBanner(msg);
      }
    },
    [
      activeChatId,
      createNewChat,
      chats,
      renameChat,
      selectedProviderId,
      selectedModelId,
      selectedMode,
      selectedEffort,
      webSearch,
      models,
      attachRunStream,
    ],
  );

  const sendMessage = React.useCallback(
    async (
      text: string,
      options?: {
        attachmentIds?: string[];
        script?:
          | 'text'
          | 'tools'
          | 'approval'
          | 'nestedApproval'
          | 'elicitation'
          | 'error'
          | 'long'
          | 'compaction'
          | 'vision';
      },
    ) => {
      // Check if selected provider is a non-local external host that needs consent
      const provider = providers.find((p) => p.id === selectedProviderId);
      if (provider && provider.id !== 'scripted') {
        try {
          const host = new URL(provider.baseUrl).hostname.toLowerCase();
          const hasConsent = consents.some((c) => c.host.toLowerCase() === host && c.allowed);
          if (!hasConsent) {
            setPendingConsentPrompt({
              host,
              purpose: 'chat',
              description: `Allow Praxis to send conversation messages and attachments to ${provider.name} (${host})?`,
              onAllow: () => {
                void apiClient.setConsent(host, true).then((c) => {
                  setConsents((prev) => [...prev.filter((x) => x.host !== c.host), c]);
                  setPendingConsentPrompt(null);
                  void executeSendMessage(text, options);
                });
              },
              onCancel: () => setPendingConsentPrompt(null),
            });
            return;
          }
        } catch {}
      }
      await executeSendMessage(text, options);
    },
    [providers, selectedProviderId, consents, executeSendMessage],
  );

  const cancelActiveRun = React.useCallback(async () => {
    if (!activeChatId) return;
    const live = liveRunsByChat[activeChatId];
    if (!live) return;
    await apiClient.cancelRun(live.run.id);
  }, [activeChatId, liveRunsByChat]);

  const resolveApproval = React.useCallback(
    async (
      runId: string,
      approvalId: string,
      decision: 'allowOnce' | 'allowAlways' | 'deny',
    ) => {
      await apiClient.submitApproval(runId, approvalId, decision);
    },
    [],
  );

  const resolveElicitation = React.useCallback(
    async (
      runId: string,
      elicitationId: string,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>,
    ) => {
      await apiClient.submitElicitation(runId, elicitationId, action, content);
    },
    [],
  );

  const setSelectedModel = React.useCallback(
    (providerId: string, modelId: string) => {
      setSelectedProviderId(providerId);
      setSelectedModelId(modelId);
      if (activeChatId) {
        void apiClient.patchChat(activeChatId, { providerId, modelId }).then((updated) => {
          setChats((prev) => prev.map((c) => (c.id === activeChatId ? updated : c)));
        }).catch(err => setErrorBanner(err instanceof Error ? err.message : 'Unable to save model'));
      }
    },
    [activeChatId],
  );

  const toggleModelPin = React.useCallback(
    async (providerId: string, modelId: string, pinned: boolean) => {
      try {
        const updated = await apiClient.updateModelPreference({ providerId, modelId, pinned });
        setModels((prev) =>
          prev.map((m) =>
            m.providerId === providerId && m.id === modelId ? updated : m,
          ),
        );
      } catch (err) { setErrorBanner(err instanceof Error ? err.message : 'Request failed'); }
    },
    [],
  );

  const saveProvider = React.useCallback(
    async (input: {
      id?: string;
      name: string;
      flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
      baseUrl: string;
      defaultModel?: string;
      apiKey?: string;
      capabilities?: Capabilities;
      extraHeaders?: Record<string, string>;
    }): Promise<Provider> => {
      if (input.id) {
        const updated = await apiClient.patchProvider(input.id, input);
        setProviders((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        return updated;
      }
      const created = await apiClient.createProvider({
        ...input,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      });
      setProviders((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const removeProvider = React.useCallback(async (providerId: string) => {
    await apiClient.deleteProvider(providerId);
    setProviders((prev) => prev.filter((p) => p.id !== providerId));
  }, []);

  const refreshModelsForProvider = React.useCallback(async (providerId: string) => {
    const page = await apiClient.refreshProviderModels(providerId);
    setModels((prev) => {
      const others = prev.filter((m) => m.providerId !== providerId);
      return [...others, ...page.items];
    });
    return page.items;
  }, []);

  const createConnector = React.useCallback(
    async (input: {
      name: string;
      url: string;
      transport?: 'streamableHttp' | 'sse';
      token?: string;
    }) => {
      const created = await apiClient.createConnector(input);
      setConnectors((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const updateConnector = React.useCallback(
    async (
      connectorId: string,
      patch: { enabled?: boolean; trusted?: boolean; name?: string; url?: string },
    ) => {
      const updated = await apiClient.patchConnector(connectorId, patch);
      setConnectors((prev) => prev.map((c) => (c.id === connectorId ? updated : c)));
    },
    [],
  );

  const removeConnector = React.useCallback(async (connectorId: string) => {
    await apiClient.deleteConnector(connectorId);
    setConnectors((prev) => prev.filter((c) => c.id !== connectorId));
  }, []);

  const loadConnectorTools = React.useCallback(async (connectorId: string) => {
    const page = await apiClient.listConnectorTools(connectorId);
    setConnectorTools((prev) => ({ ...prev, [connectorId]: page.items }));
    return page.items;
  }, []);

  const setConnectorToolEnabled = React.useCallback(
    async (connectorId: string, toolName: string, enabled: boolean) => {
      const updated = await apiClient.toggleConnectorTool(connectorId, toolName, enabled);
      setConnectors((prev) => prev.map((c) => (c.id === connectorId ? updated : c)));
    },
    [],
  );

  const saveSkill = React.useCallback(
    async (input: {
      id?: string;
      name: string;
      description: string;
      document: string;
      enabled?: boolean;
    }): Promise<Skill> => {
      if (input.id) {
        const updated = await apiClient.patchSkill(input.id, input);
        setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        return updated;
      }
      const created = await apiClient.createSkill(input);
      setSkills((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const removeSkill = React.useCallback(async (skillId: string) => {
    await apiClient.deleteSkill(skillId);
    setSkills((prev) => prev.filter((s) => s.id !== skillId));
  }, []);

  const addSkillRegistry = React.useCallback(async (name: string, url: string) => {
    const created = await apiClient.createSkillRegistry({ name, url, enabled: true });
    setRegistries((prev) => [...prev, created]);
    return created;
  }, []);

  const removeSkillRegistry = React.useCallback(async (registryId: string) => {
    await apiClient.deleteSkillRegistry(registryId);
    setRegistries((prev) => prev.filter((r) => r.id !== registryId));
  }, []);

  const searchRegistry = React.useCallback(async (registryId: string, q = '') => {
    const page = await apiClient.searchSkillRegistry(registryId, q);
    setRegistryEntries((prev) => ({ ...prev, [registryId]: page.items }));
    return page.items;
  }, []);

  const installSkillFromRegistry = React.useCallback(
    async (registryId: string, skillEntryId: string) => {
      const installed = await apiClient.installRegistrySkill(registryId, skillEntryId);
      setSkills((prev) => [...prev.filter((s) => s.id !== installed.id), installed]);
      return installed;
    },
    [],
  );

  const grantConsent = React.useCallback(async (host: string, allowed: boolean) => {
    const updated = await apiClient.setConsent(host, allowed);
    setConsents((prev) => [...prev.filter((c) => c.host !== updated.host), updated]);
  }, []);

  const updatePreferences = React.useCallback(
    async (input: {
      vision?: { providerId?: string; modelId?: string; enabled?: boolean };
      voice?: { model?: string; language?: string; apiKey?: string };
    }) => {
      const updated = await apiClient.patchPreferences(input);
      setPreferences(updated);
    },
    [],
  );

  const { uploadFiles, transcribeAudioBlob } = useMediaActions({
    activeChatId, preferences, setAttachmentsById, setErrorBanner,
  });

  const activeChat = React.useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );
  const activeMessages = React.useMemo(
    () => (activeChatId ? (messagesByChat[activeChatId] ?? []) : []),
    [messagesByChat, activeChatId],
  );
  const activeLiveRun = React.useMemo(
    () => (activeChatId ? (liveRunsByChat[activeChatId] ?? null) : null),
    [liveRunsByChat, activeChatId],
  );

  const value: PraxisStoreContextValue = {
    hydrated,
    syncing,
    errorBanner,
    clearErrorBanner: () => setErrorBanner(null),
    themeMode,
    resolvedTheme,
    setThemeMode,
    activeSheet,
    setActiveSheet,
    restoreRoute,
    startNewConversation,
    editingProviderId,
    setEditingProviderId,
    desktopSidebarOpen,
    setDesktopSidebarOpen,
    plusTrayOpen,
    setPlusTrayOpen,
    inlineModelSearchActive,
    setInlineModelSearchActive,
    chats,
    activeChatId,
    activeChat,
    messagesByChat,
    activeMessages,
    providers,
    models,
    connectors,
    connectorTools,
    skills,
    registries,
    registryEntries,
    consents,
    preferences,
    attachmentsById,
    selectedProviderId,
    selectedModelId,
    selectedEffort,
    webSearch,
    setWebSearch,
    cacheModels,
    selectedMode,
    setSelectedModel,
    setSelectedEffort,
    setSelectedMode,
    liveRunsByChat,
    activeLiveRun,
    pendingConsentPrompt,
    setPendingConsentPrompt,
    selectChat,
    createNewChat,
    renameChat,
    togglePinChat,
    deleteChats,
    toggleChatConnector,
    sendMessage,
    cancelActiveRun,
    resolveApproval,
    resolveElicitation,
    toggleModelPin,
    saveProvider,
    removeProvider,
    refreshModelsForProvider,
    createConnector,
    updateConnector,
    removeConnector,
    loadConnectorTools,
    setConnectorToolEnabled,
    saveSkill,
    removeSkill,
    addSkillRegistry,
    removeSkillRegistry,
    searchRegistry,
    installSkillFromRegistry,
    grantConsent,
    updatePreferences,
    uploadFiles,
    transcribeAudioBlob,
    refreshAll,
  };

  return <PraxisStoreContext.Provider value={value}>{children}</PraxisStoreContext.Provider>;
}
