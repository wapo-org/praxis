import type { ResolvedTheme, ThemeMode } from '@praxis/glass';
import type {
  Attachment,
  Chat,
  Connector,
  Message,
  Model,
  Provider,
  Skill,
} from '@praxis/protocol';
import React from 'react';
import { requestComposerFocus } from '../components/chat/composerFocus';
import { DEFAULT_MODE, type Mode } from '../lib/modes';

import {
  apiClient,
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
  type ToolSpec,
} from '../lib/api';
import { getReplicaIdentity, readReplicaSync } from '../lib/idb';
import { readStoredSelection } from './modelSelection';
import { pathForSheet } from '../lib/navigation';
import { mergeFetchedMessages } from './reconcileMessages';

import type { ActiveSheet, LiveRunState, PendingConsentPrompt } from './types';
export function usePraxisState(onNavigate?: (path: string) => void) {
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
  const activeSheetRef = React.useRef<ActiveSheet>(activeSheet);
  activeSheetRef.current = activeSheet;
  const [editingProviderId, setEditingProviderIdState] = React.useState<string | null>(null);
  const providerIdRef = React.useRef(editingProviderId);
  const setEditingProviderId = (id: string | null) => {
    providerIdRef.current = id;
    setEditingProviderIdState(id);
  };
  // Right from the first render, so the sidebar does not fly in on every load.
  const [desktopSidebarOpen, setDesktopSidebarOpen] = React.useState<boolean>(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches,
  );
  const [plusTrayOpen, setPlusTrayOpen] = React.useState<boolean>(false);
  const [inlineModelSearchActive, setInlineModelSearchActive] = React.useState<boolean>(false);

  // Entities initialized from synchronous replica cache first (<16ms paint)
  const [chats, setChats] = React.useState<Chat[]>(() => initialCache?.chats ?? []);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const activeChatIdRef = React.useRef<string | null>(activeChatId);
  activeChatIdRef.current = activeChatId;
  /** Placeholder until the first message generates the conversation title. */
  const [draftTitle, setDraftTitle] = React.useState(() => 'New chat');
  const [messagesByChat, setMessagesByChat] = React.useState<Record<string, Message[]>>(
    () => initialCache?.messagesByChat ?? {},
  );
  const [providers, setProviders] = React.useState<Provider[]>(() => initialCache?.providers ?? []);
  const [models, setModels] = React.useState<Model[]>(() =>
    initialCache?.models?.length ? initialCache.models : [],
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
  const [syncCursor, setSyncCursor] = React.useState<string>(() => initialCache?.syncCursor ?? '0');

  // Selected composer controls
  // Starts from this account's last selection (WP-K2b), not from the first model in the list.
  const storedSelection = React.useMemo(() => readStoredSelection(replicaKey.current), []);
  const [selectedProviderId, setSelectedProviderId] = React.useState<string>(() => storedSelection?.providerId ?? '');
  const [selectedModelId, setSelectedModelId] = React.useState<string>(() => storedSelection?.modelId ?? '');
  /** The full model list has loaded (bootstrap answered or failed): only then may a missing model be replaced. */
  const [catalogReady, setCatalogReady] = React.useState(false);
  /** A model the user picked whose save to the chat has not answered yet: nothing automatic replaces it. */
  const pendingPickRef = React.useRef<{ chatId: string; providerId: string; modelId: string } | null>(null);
  const [webSearch, setWebSearch] = React.useState(false);
  const cacheModels = React.useCallback(
    (items: Model[]) =>
      setModels((prev) => [
        ...prev.filter((p) => !items.some((m) => m.providerId === p.providerId && m.id === p.id)),
        ...items,
      ]),
    [],
  );
  const [selectedEffort, setSelectedEffort] = React.useState<string>('medium');
  const [selectedMode, setSelectedMode] = React.useState<Mode>(DEFAULT_MODE);

  const [liveRunsByChat, setLiveRunsByChat] = React.useState<Record<string, LiveRunState>>({});
  const [pendingConsentPrompt, setPendingConsentPrompt] =
    React.useState<PendingConsentPrompt | null>(null);

  /** Optimistic new-chat POSTs in flight: restoreRoute skips premature listMessages for these IDs. */
  const creatingChatPromisesRef = React.useRef<Map<string, Promise<void>>>(new Map());
  /** Local turns stopped while POST /v1/runs was still queued/in-flight. */
  const cancelledTurnIdsRef = React.useRef<Set<string>>(new Set());
  /** Chat ID armed by an explicit sidebar/navigation chat switch for one entrance stagger pass. */
  const pendingChatSwitchRef = React.useRef<string | null>(null);
  /** Chat ID whose navigation came from selectChat (which already issued listMessages). */
  const navigatingChatRef = React.useRef<string | null>(null);

  const setActiveSheet = (sheet: ActiveSheet) => {
    activeSheetRef.current = sheet;
    setActiveSheetState(sheet);
    onNavigate?.(pathForSheet(sheet, activeChatIdRef.current, providerIdRef.current));
  };
  const startNewConversation = () => {
    pendingChatSwitchRef.current = null;
    navigatingChatRef.current = null;
    activeChatIdRef.current = null;
    activeSheetRef.current = null;
    setDraftTitle('New chat');
    setActiveChatId(null);
    setActiveSheetState(null);
    setPlusTrayOpen(false);
    onNavigate?.('/');
    // Button, shortcut or phone drawer: the caret lands in the composer (inside the gesture where possible).
    requestComposerFocus();
  };
  const restoreRoute = (chatId: string | null, sheet: ActiveSheet, providerId?: string | null) => {
    activeSheetRef.current = sheet;
    setActiveSheetState(sheet);
    if (providerId !== undefined) setEditingProviderId(providerId);
    if (sheet) return;
    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
    if (!chatId) return;
    // Brand-new optimistic chat: messages are already staged locally and server POST /v1/chats may still be in flight.
    if (creatingChatPromisesRef.current.has(chatId)) return;
    // selectChat already kicked off listMessages for this navigation.
    if (navigatingChatRef.current === chatId) {
      navigatingChatRef.current = null;
      return;
    }
    void apiClient
      .listMessages(chatId)
      .then((page) => {
        if (activeChatIdRef.current !== chatId) return;
        setMessagesByChat((prev) => ({
          ...prev,
          [chatId]: mergeFetchedMessages(prev[chatId] ?? [], page.items),
        }));
      })
      .catch((err) => setErrorBanner(err instanceof Error ? err.message : 'Unable to open chat'));
  };
  const activeRunUnsubMapRef = React.useRef<Map<string, () => void>>(new Map());
  /** clientTurnIds this tab started: their runs are attached by the send path, not by the user-event follower. */
  const localTurnIdsRef = React.useRef<Set<string>>(new Set());
  /** Newest user-event id from bootstrap; the live follower subscribes after it (null until bootstrapped). */
  const [eventCursor, setEventCursor] = React.useState<number | null>(null);

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
  return {
    onNavigate,
    replicaKey,
    initialCache,
    hydrated,
    setHydrated,
    syncing,
    setSyncing,
    errorBanner,
    setErrorBanner,
    themeMode,
    setThemeModeState,
    resolvedTheme,
    setResolvedTheme,
    setThemeMode,
    activeSheet,
    setActiveSheetState,
    activeSheetRef,
    editingProviderId,
    setEditingProviderIdState,
    providerIdRef,
    setEditingProviderId,
    desktopSidebarOpen,
    setDesktopSidebarOpen,
    plusTrayOpen,
    setPlusTrayOpen,
    inlineModelSearchActive,
    setInlineModelSearchActive,
    chats,
    setChats,
    activeChatId,
    setActiveChatId,
    activeChatIdRef,
    messagesByChat,
    setMessagesByChat,
    providers,
    setProviders,
    models,
    setModels,
    connectors,
    setConnectors,
    connectorTools,
    setConnectorTools,
    skills,
    setSkills,
    registries,
    setRegistries,
    registryEntries,
    setRegistryEntries,
    consents,
    setConsents,
    preferences,
    setPreferences,
    attachmentsById,
    setAttachmentsById,
    syncCursor,
    setSyncCursor,
    selectedProviderId,
    setSelectedProviderId,
    selectedModelId,
    setSelectedModelId,
    catalogReady,
    setCatalogReady,
    pendingPickRef,
    webSearch,
    setWebSearch,
    cacheModels,
    selectedEffort,
    setSelectedEffort,
    selectedMode,
    setSelectedMode,
    liveRunsByChat,
    setLiveRunsByChat,
    pendingConsentPrompt,
    setPendingConsentPrompt,
    creatingChatPromisesRef,
    cancelledTurnIdsRef,
    pendingChatSwitchRef,
    navigatingChatRef,
    setActiveSheet,
    startNewConversation,
    draftTitle,
    setDraftTitle,
    restoreRoute,
    activeRunUnsubMapRef,
    localTurnIdsRef,
    eventCursor,
    setEventCursor,
  };
}
export type PraxisState = ReturnType<typeof usePraxisState>;
