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
import {
  apiClient,
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
  type ToolSpec,
} from '../lib/api';
import { getReplicaIdentity, readReplicaSync } from '../lib/idb';
import { pathForSheet } from '../lib/navigation';

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
  const [editingProviderId, setEditingProviderIdState] = React.useState<string | null>(null);
  const providerIdRef = React.useRef(editingProviderId);
  const setEditingProviderId = (id: string | null) => {
    providerIdRef.current = id;
    setEditingProviderIdState(id);
  };
  const [desktopSidebarOpen, setDesktopSidebarOpen] = React.useState<boolean>(false);
  const [plusTrayOpen, setPlusTrayOpen] = React.useState<boolean>(false);
  const [inlineModelSearchActive, setInlineModelSearchActive] = React.useState<boolean>(false);

  // Entities initialized from synchronous replica cache first (<16ms paint)
  const [chats, setChats] = React.useState<Chat[]>(() => initialCache?.chats ?? []);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
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
  const [selectedProviderId, setSelectedProviderId] = React.useState<string>('');
  const [selectedModelId, setSelectedModelId] = React.useState<string>('');
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
  const [selectedMode, setSelectedMode] = React.useState<'ask' | 'plan' | 'build' | 'auto'>(
    'build',
  );

  const [liveRunsByChat, setLiveRunsByChat] = React.useState<Record<string, LiveRunState>>({});
  const [pendingConsentPrompt, setPendingConsentPrompt] =
    React.useState<PendingConsentPrompt | null>(null);

  const setActiveSheet = (sheet: ActiveSheet) => {
    setActiveSheetState(sheet);
    onNavigate?.(pathForSheet(sheet, activeChatId, providerIdRef.current));
  };
  const startNewConversation = () => {
    setActiveChatId(null);
    setActiveSheetState(null);
    setPlusTrayOpen(false);
    onNavigate?.('/');
  };
  const restoreRoute = (chatId: string | null, sheet: ActiveSheet, providerId?: string | null) => {
    setActiveSheetState(sheet);
    if (providerId !== undefined) setEditingProviderId(providerId);
    if (sheet) return;
    setActiveChatId(chatId);
    if (chatId)
      void apiClient
        .listMessages(chatId)
        .then((page) => {
          setMessagesByChat((prev) => ({ ...prev, [chatId]: page.items }));
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
    setActiveSheet,
    startNewConversation,
    restoreRoute,
    activeRunUnsubMapRef,
    localTurnIdsRef,
    eventCursor,
    setEventCursor,
  };
}
export type PraxisState = ReturnType<typeof usePraxisState>;
