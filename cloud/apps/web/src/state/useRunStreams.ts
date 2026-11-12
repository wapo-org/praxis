import type { Run, RunEvent } from '@praxis/protocol';
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

      let frame = 0;
      let pending: RunEvent[] = [];
      const flush = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        const batch = pending;
        pending = [];
        for (const event of batch) handleRunEvent(event);
      };
      const stop = subscribeRunEvents(apiClient, run.id, afterEventId, {
        onEvent: (event) => {
          pending.push(event);
          if (document.hidden || !['text.delta', 'reasoning.delta'].includes(event.event.type)) {
            flush();
          } else if (!frame) {
            frame = requestAnimationFrame(flush);
          }
        },
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
      activeRunUnsubMapRef.current.set(run.id, () => { flush(); stop(); });
    },
    [handleRunEvent, applySnapshotToLiveRun],
  );

  return { attachRunStream };
}
