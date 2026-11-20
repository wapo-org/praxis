import type { ResolvedTheme, ThemeMode } from '@praxis/glass';
import type {
  Attachment,
  Chat,
  Message,
  Skill,
  ModelKey,
  ModelListItem,
} from '@praxis/protocol';
import { ModelListItemSchema } from '@praxis/protocol';
import React from 'react';
import { requestComposerFocus } from '../components/chat/composerFocus';
import { DEFAULT_MODE, type Mode } from '../lib/modes';

import {
  apiClient,
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
} from '../lib/api';
import { getReplicaIdentity, readReplicaSync } from '../lib/idb';
import { readStoredSelection } from './modelSelection';
import { pathForSheet } from '../lib/navigation';
import { mergeFetchedMessages } from './reconcileMessages';

import type { ActiveSheet, LiveRunState, PendingConsentPrompt } from './types';

/** The width at which the sidebar docks beside the content instead of covering it. */
export const DESKTOP_SIDEBAR_QUERY = '(min-width: 1024px)';

function desktopSidebarFits(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches;
}

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
  // Docked from the first paint: opened in an effect, the column and composer glided 122 px on every desktop load.
  const [desktopSidebarOpen, setDesktopSidebarOpen] = React.useState<boolean>(desktopSidebarFits);
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
  const activeSheetRef = React.useRef<ActiveSheet>(null);
  const [modelKey, setModelKey] = React.useState<ModelKey | null>(() => initialCache?.modelKey ?? null);
  // A replica cached before OpenRouter holds the old per-provider model shape: only catalogue entries are kept.
  const [models, setModels] = React.useState<ModelListItem[]>(() =>
    (initialCache?.models ?? []).filter((m) => ModelListItemSchema.safeParse(m).success),
  );
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
  const [selectedModelId, setSelectedModelId] = React.useState<string>(() => readStoredSelection(replicaKey.current)?.modelId ?? '');
  const [catalogReady, setCatalogReady] = React.useState(false);
  const pendingPickRef = React.useRef<{chatId: string; modelId: string} | null>(null);
  const cacheModels = React.useCallback(
    (items: ModelListItem[]) =>
      setModels((prev) => [
        ...prev.filter((p) => !items.some((m) => m.id === p.id)),
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
    onNavigate?.(pathForSheet(sheet, activeChatId));
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
  const restoreRoute = (chatId: string | null, sheet: ActiveSheet) => {
    setActiveSheetState(sheet);
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
    activeSheetRef,
    activeChatIdRef,
    messagesByChat,
    setMessagesByChat,
    modelKey,
    setModelKey,
    models,
    setModels,
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
    selectedModelId,
    setSelectedModelId,
    catalogReady,
    setCatalogReady,
    pendingPickRef,
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
