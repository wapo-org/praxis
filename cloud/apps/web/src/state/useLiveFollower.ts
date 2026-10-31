import { ChatSchema, RunSchema, type UserEvent } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../lib/api';
import { subscribeUserEvents } from '../lib/user-events';
import type { PraxisState } from './usePraxisState';
import type { useRunState } from './useRunState';
import type { useRunStreams } from './useRunStreams';

const terminal = (status: string) => ['completed', 'cancelled', 'failed'].includes(status);

/**
 * Attaches live to runs started on another client (iOS, another tab, the API) for this account: chat and run
 * upserts on the user channel name the run; the snapshot restores text, tools and pending approvals/elicitations,
 * then the run stream continues it. Runs this tab started are attached by the send path instead.
 */
export function useLiveFollower(
  state: PraxisState,
  { attachRunStream, applySnapshotToLiveRun }: ReturnType<typeof useRunStreams> & ReturnType<typeof useRunState>,
) {
  const { eventCursor, setChats, setMessagesByChat, activeRunUnsubMapRef, localTurnIdsRef } = state;
  const following = React.useRef(new Set<string>());
  const handlers = React.useRef({ attachRunStream, applySnapshotToLiveRun });
  handlers.current = { attachRunStream, applySnapshotToLiveRun };

  const follow = React.useCallback(async (runId: string) => {
    if (activeRunUnsubMapRef.current.has(runId) || following.current.has(runId)) return;
    following.current.add(runId);
    try {
      const snapshot = await apiClient.getRunSnapshot(runId);
      const { run } = snapshot;
      if ((run.clientTurnId && localTurnIdsRef.current.has(run.clientTurnId)) || activeRunUnsubMapRef.current.has(run.id)) return;
      const page = await apiClient.listMessages(run.chatId);
      setMessagesByChat((prev) => ({ ...prev, [run.chatId]: page.items }));
      handlers.current.applySnapshotToLiveRun(snapshot);
      if (!terminal(run.status)) handlers.current.attachRunStream(run, snapshot.lastEventId);
    } catch {
      // A run that vanished or can't be read is simply not followed; the next chat upsert retries.
    } finally {
      following.current.delete(runId);
    }
  }, []);

  const onEvent = React.useCallback((event: UserEvent) => {
    if (event.entity === 'chat') {
      if (event.operation === 'delete') {
        setChats((prev) => prev.filter((chat) => chat.id !== event.entityId));
        return;
      }
      const chat = ChatSchema.safeParse(event.value);
      if (!chat.success) return;
      setChats((prev) =>
        prev.some((c) => c.id === chat.data.id) ? prev.map((c) => (c.id === chat.data.id ? chat.data : c)) : [chat.data, ...prev],
      );
      if (chat.data.activeRunId) void follow(chat.data.activeRunId);
    } else if (event.entity === 'run' && event.operation === 'upsert') {
      const run = RunSchema.safeParse(event.value);
      if (run.success && !terminal(run.data.status)) void follow(run.data.id);
    }
  }, [follow]);

  React.useEffect(() => {
    if (eventCursor === null) return;
    return subscribeUserEvents(apiClient, eventCursor, onEvent);
  }, [eventCursor, onEvent]);
}
