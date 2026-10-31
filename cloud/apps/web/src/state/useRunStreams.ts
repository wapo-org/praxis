import type { Run } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../lib/api';
import { subscribeRunEvents } from '../lib/sse';

import type { PraxisState } from './usePraxisState';
import type { useRunState } from './useRunState';
export function useRunStreams(
  state: PraxisState,
  { handleRunEvent, applySnapshotToLiveRun }: ReturnType<typeof useRunState>,
) {
  const { setChats, setMessagesByChat, activeRunUnsubMapRef } = state;
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
            .getChat(run.chatId)
            .then((chat) =>
              setChats((prev) => prev.map((value) => (value.id === chat.id ? chat : value))),
            )
            .catch(() => {});
          void apiClient
            .listMessages(run.chatId)
            .then((page) => {
              setMessagesByChat((prev) => ({
                ...prev,
                [run.chatId]: page.items,
              }));
            })
            .catch(() => {});
        },
      });
      activeRunUnsubMapRef.current.set(run.id, unsub);
    },
    [handleRunEvent, applySnapshotToLiveRun],
  );

  return { attachRunStream };
}
