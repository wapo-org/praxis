import React from 'react';
import { apiClient } from '../lib/api';
import { saveReplica, type LocalReplicaSnapshot } from '../lib/idb';

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
    selectedModelId,
    setSelectedModelId,
    setSelectedEffort,
    setSelectedMode,
  } = state;
  const persistState = React.useCallback(
    (nextPartial?: Partial<LocalReplicaSnapshot>) => {
      const snap: LocalReplicaSnapshot = {
        chats,
        messagesByChat,
        models,
        modelKey,
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
      models,
      modelKey,
      connectors,
      skills,
      consents,
      registries,
      preferences,
      syncCursor,
    ],
  );

  const refreshAll = React.useCallback(async () => {
    setSyncing(true);
    try {
      const boot = await apiClient.bootstrap();
      setChats(boot.chats);
      setModelKey(boot.modelKey ?? null);
      // The catalogue is not in bootstrap; a failed first page must not block the app.
      const catalogue = await apiClient
        .listModels({ limit: 100 })
        .then((page) => page.items)
        .catch(() => null);
      if (catalogue) setModels(catalogue);
      if (!selectedModelId && catalogue?.[0]) setSelectedModelId(catalogue[0].id);
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
          models: catalogue ?? models,
          modelKey: boot.modelKey ?? null,
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

      const firstChatId = activeChatId;
      if (firstChatId && !activeChatId) {
        setActiveChatId(firstChatId);
      }
      if (firstChatId) {
        const msgPage = await apiClient.listMessages(firstChatId);
        setMessagesByChat((prev) => {
          const next = { ...prev, [firstChatId]: msgPage.items };
          void saveReplica(
            {
              bootstrap: boot,
              chats: boot.chats,
              messagesByChat: next,
              models: catalogue ?? models,
              modelKey: boot.modelKey ?? null,
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

  const routeChat = chats.find((value) => value.id === activeChatId);
  React.useEffect(() => {
    if (routeChat?.modelId) setSelectedModelId(routeChat.modelId);
  }, [activeChatId, routeChat?.modelId]);
  React.useEffect(() => {
    if (routeChat?.mode) setSelectedMode(routeChat.mode);
  }, [activeChatId, routeChat?.mode]);
  React.useEffect(() => {
    if (routeChat?.effort) setSelectedEffort(routeChat.effort);
  }, [activeChatId, routeChat?.effort]);

  React.useEffect(() => {
    void refreshAll();
  }, []);

  return { persistState, refreshAll, routeChat };
}
