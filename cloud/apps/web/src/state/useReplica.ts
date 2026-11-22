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
    modelKey,
    setModelKey,
    models,
    setModels,
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
        models,
        modelKey,
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
      models,
      modelKey,
      skills,
      consents,
      registries,
      preferences,
      syncCursor,
    ],
  );

  React.useEffect(() => { persistState(); }, [persistState]);

  React.useEffect(() => { writeStoredSelection(replicaKey.current, {modelId:selectedModelId}); }, [selectedModelId]);

  const refreshAll = React.useCallback(async () => {
    setSyncing(true);
    try {
      const boot = await apiClient.bootstrap();
      state.setUser(boot.user);
      setChats(boot.chats);
      setModelKey(boot.modelKey ?? null);
      // The catalogue is not in bootstrap; a failed first page must not block the app.
      const catalogue = await apiClient
        .listModels({ limit: 100 })
        .then(async page => {
          const items = [...page.items];
          while (page.nextCursor) {
            page = await apiClient.listModels({limit:100,cursor:page.nextCursor});
            items.push(...page.items);
          }
          return items;
        })
        .catch(() => null);
      if (catalogue) { setModels(catalogue); state.setCatalogReady(true); }
      else if (models.length > 0) state.setCatalogReady(true);
      if (!selectedModelId && catalogue?.[0]) setSelectedModelId(catalogue[0].id);
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
          models: catalogue ?? models,
          modelKey: boot.modelKey ?? null,
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
              models: catalogue ?? models,
              modelKey: boot.modelKey ?? null,
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
  const decidedChat = React.useRef<string | null | undefined>(undefined);
  const lastChatModel = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const chatKey = activeChatId ?? null;
    const chatModel = routeChat?.modelId ? { modelId: routeChat.modelId } : undefined;
    const chatModelKey = chatModel ? chatModel.modelId : undefined;
    const pending = state.pendingPickRef.current;
    // The open chat's model changed elsewhere (another device): follow it, unless our own pick is in flight.
    const remoteChange = decidedChat.current === chatKey && chatModelKey !== lastChatModel.current && !(pending && pending.chatId === activeChatId);
    lastChatModel.current = chatModelKey;
    const decision = decideSelection({
      chatChanged: decidedChat.current !== chatKey || remoteChange,
      chatModel,
      current: { modelId: selectedModelId },
      models,
      ready: state.catalogReady,
    });
    if (decision.kind === 'wait') return;
    decidedChat.current = chatKey;
    if (decision.kind === 'select') {
      setSelectedModelId(decision.ref.modelId);
      if (decision.notice) setErrorBanner(decision.notice);
    }
  }, [activeChatId, routeChat?.modelId, models, state.catalogReady, selectedModelId]);
  React.useEffect(() => {
    if (routeChat?.modelId && models.some((model) => model.id === routeChat.modelId)) {
      setSelectedModelId(routeChat.modelId);
    }
  }, [activeChatId, routeChat?.modelId, models]);
  React.useEffect(() => {
    if (routeChat?.mode) setSelectedMode(fromWireMode(routeChat.mode)); // a stored plan reads as Auto
  }, [activeChatId, routeChat?.mode]);
  React.useEffect(() => {
    if (routeChat?.effort) setSelectedEffort(routeChat.effort);
  }, [activeChatId, routeChat?.effort]);

  React.useEffect(() => {
    void refreshAll();
  }, []);

  return { persistState, refreshAll, routeChat };
}
