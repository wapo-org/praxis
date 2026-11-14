import {useAccountSync} from '../sync/useAccountSync';
import React from 'react';
import { fromWireMode } from '../lib/modes';
import { decideSelection, writeStoredSelection } from './modelSelection';
import { apiClient } from '../lib/api';
import { readReplicaSync, saveReplica, type LocalReplicaSnapshot } from '../lib/idb';
import { mergeFetchedMessages } from './reconcileMessages';

import type { PraxisState } from './usePraxisState';
import type { useRunState } from './useRunState';
import type { useRunStreams } from './useRunStreams';
export function useReplica(
  state: PraxisState,
  {
    attachRunStream,
    applySnapshotToLiveRun,
  }: ReturnType<typeof useRunStreams> &
    Pick<ReturnType<typeof useRunState>, 'applySnapshotToLiveRun'>,
) {
  useAccountSync(state, {attachRunStream, applySnapshotToLiveRun});
  const {
    replicaKey,
    setHydrated,
    setSyncing,
    setErrorBanner,
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
    skills,
    setSkills,
    registries,
    setRegistries,
    consents,
    setConsents,
    preferences,
    setPreferences,
    syncCursor,
    setSyncCursor,
    setSelectedProviderId,
    selectedProviderId,
    selectedModelId,
    setSelectedModelId,
    setSelectedEffort,
    setSelectedMode,
  } = state;
  const persistState = React.useCallback(
    (nextPartial?: Partial<LocalReplicaSnapshot>) => {
      const snap: LocalReplicaSnapshot = {
        bootstrap: readReplicaSync()?.bootstrap,
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

  React.useEffect(() => { persistState(); }, [persistState]);

  const refreshAll = React.useCallback(async () => {
    setSyncing(true);
    try {
      const boot = await apiClient.bootstrap();
      setChats((prev) => {
        const creating = state.creatingChatPromisesRef.current;
        const optimistic = prev.filter((c) => creating.has(c.id) && !boot.chats.some((b) => b.id === c.id));
        return [...optimistic, ...boot.chats];
      });
      setProviders(boot.providers);
      setModels(boot.models);
      // No reset here: the selection resolver below decides, now that the list is complete (WP-K2b).
      state.setCatalogReady(true);
      setConnectors(boot.connectors);
      setSkills(boot.skills);
      if (boot.consents) setConsents(boot.consents);
      if (boot.registries) setRegistries(boot.registries);
      if (boot.preferences) setPreferences(boot.preferences);
      setSyncCursor(boot.syncCursor);
      state.setEventCursor(boot.eventCursor ?? 0);

      await saveReplica(
        {
          bootstrap: boot,
          chats: boot.chats,
          messagesByChat,
          providers: boot.providers,
          models: boot.models,
          connectors: boot.connectors,
          skills: boot.skills,
          consents: boot.consents ?? [],
          registries: boot.registries ?? [],
          preferences: boot.preferences,
          syncCursor: boot.syncCursor,
          updatedAt: Date.now(),
        },
        replicaKey.current,
      );

      const firstChatId = state.activeChatIdRef.current ?? activeChatId;
      if (firstChatId && !activeChatId) {
        setActiveChatId(firstChatId);
      }
      if (firstChatId && !state.creatingChatPromisesRef.current.has(firstChatId)) {
        const msgPage = await apiClient.listMessages(firstChatId);
        setMessagesByChat((prev) => {
          const next = {
            ...prev,
            [firstChatId]: mergeFetchedMessages(prev[firstChatId] ?? [], msgPage.items),
          };
          void saveReplica(
            {
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
            },
            replicaKey.current,
          );
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
      // Offline or failing: the cached list is all there will be.
      state.setCatalogReady(true);
    } finally {
      setSyncing(false);
    }
  }, [activeChatId, applySnapshotToLiveRun, attachRunStream]);

  const routeChat = chats.find((value) => value.id === activeChatId);
  // WP-K2b: the selection changes on its own only when the open chat changes (to that chat's model) or when
  // the selected model is no longer available, and the latter only once the full list has loaded. A valid
  // choice, or one whose save is still pending, is never replaced.
  const decidedChat = React.useRef<string | null | undefined>(undefined);
  const lastChatModel = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const chatKey = activeChatId ?? null;
    const chatModel = routeChat?.providerId && routeChat.modelId ? { providerId: routeChat.providerId, modelId: routeChat.modelId } : undefined;
    const chatModelKey = chatModel ? `${chatModel.providerId}/${chatModel.modelId}` : undefined;
    const pending = state.pendingPickRef.current;
    // The open chat's model changed elsewhere (another device): follow it, unless our own pick is in flight.
    const remoteChange = decidedChat.current === chatKey && chatModelKey !== lastChatModel.current && !(pending && pending.chatId === activeChatId);
    lastChatModel.current = chatModelKey;
    const decision = decideSelection({
      chatChanged: decidedChat.current !== chatKey || remoteChange,
      chatModel,
      current: { providerId: selectedProviderId, modelId: selectedModelId },
      models,
      providers,
      ready: state.catalogReady,
    });
    if (decision.kind === 'wait') return;
    decidedChat.current = chatKey;
    if (decision.kind === 'select') {
      setSelectedProviderId(decision.ref.providerId);
      setSelectedModelId(decision.ref.modelId);
      if (decision.notice) setErrorBanner(decision.notice);
    }
  }, [activeChatId, routeChat?.providerId, routeChat?.modelId, models, providers, state.catalogReady, selectedProviderId, selectedModelId]);
  React.useEffect(() => {
    writeStoredSelection(replicaKey.current, { providerId: selectedProviderId, modelId: selectedModelId });
  }, [selectedProviderId, selectedModelId]);
  React.useEffect(() => {
    if (routeChat?.mode) setSelectedMode(fromWireMode(routeChat.mode)); // a stored plan reads as Auto
  }, [activeChatId, routeChat?.mode]);
  React.useEffect(() => {
    if (routeChat?.effort) setSelectedEffort(routeChat.effort);
  }, [activeChatId, routeChat?.effort]);

  // The account gate loads only the verified user’s replica before mounting.
  React.useEffect(() => {
    void refreshAll();
  }, []);

  return { persistState, refreshAll, routeChat };
}
