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
    } finally {
      setSyncing(false);
    }
  }, [activeChatId, applySnapshotToLiveRun, attachRunStream]);

  const routeChat = chats.find((value) => value.id === activeChatId);
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

  return { persistState, refreshAll, routeChat };
}
