import type { Chat } from '@praxis/protocol';
import React from 'react';
import { fromWireMode, toWireMode } from '../lib/modes';
import { apiClient } from '../lib/api';
import { mergeFetchedMessages } from './reconcileMessages';

import type { PraxisState } from './usePraxisState';
import type { useReplica } from './useReplica';
export function useChatActions(
  state: PraxisState,
  { persistState }: Pick<ReturnType<typeof useReplica>, 'persistState'>,
) {
  const {
    onNavigate,
    setErrorBanner,
    chats,
    setChats,
    activeChatId,
    setActiveChatId,
    setMessagesByChat,
    selectedModelId,
    setSelectedModelId,
    selectedEffort,
    setSelectedEffort,
    selectedMode,
    setSelectedMode,
  } = state;
  const selectSeqRef = React.useRef(0);
  const selectChat = React.useCallback(
    async (chatId: string) => {
      const seq = ++selectSeqRef.current;
      const isSwitch =
        state.activeChatIdRef.current !== chatId || state.activeSheetRef.current !== null;
      if (isSwitch) {
        state.pendingChatSwitchRef.current = chatId;
      }
      if (typeof performance !== 'undefined') {
        performance.mark('praxis:chat-switch-start');
      }
      state.activeChatIdRef.current = chatId;
      state.navigatingChatRef.current = chatId;
      setActiveChatId(chatId);
      onNavigate?.(`/c/${encodeURIComponent(chatId)}`);
      const chat = chats.find((c) => c.id === chatId);
      if (chat?.modelId) setSelectedModelId(chat.modelId);
      if (chat?.effort) setSelectedEffort(chat.effort);
      if (chat?.mode) setSelectedMode(fromWireMode(chat.mode));

      requestAnimationFrame(() => {
        if (typeof performance !== 'undefined') {
          performance.mark('praxis:chat-switch-end');
          try {
            performance.measure(
              'praxis:chat-switch',
              'praxis:chat-switch-start',
              'praxis:chat-switch-end',
            );
          } catch {}
        }
      });

      const creating = state.creatingChatPromisesRef.current.get(chatId);
      if (creating) {
        await creating;
      }

      try {
        const page = await apiClient.listMessages(chatId);
        if (selectSeqRef.current !== seq) return;
        setMessagesByChat((prev) => {
          const next = { ...prev, [chatId]: mergeFetchedMessages(prev[chatId] ?? [], page.items) };
          persistState({ messagesByChat: next });
          return next;
        });
      } catch (err) {
        if (selectSeqRef.current !== seq) return;
        setErrorBanner(err instanceof Error ? err.message : 'Unable to load messages');
      }
    },
    [chats, persistState],
  );

  const createNewChat = React.useCallback(
    async (title = 'New chat', id?: string): Promise<Chat> => {
      const created = await apiClient.createChat({
        id,
        title,
        mode: toWireMode(selectedMode),

        modelId: selectedModelId,
        effort: selectedEffort,
      });
      setChats((prev) => {
        const next = [created, ...prev.filter((c) => c.id !== created.id)];
        persistState({ chats: next });
        return next;
      });
      state.activeChatIdRef.current = created.id;
      setActiveChatId(created.id);
      onNavigate?.(`/c/${encodeURIComponent(created.id)}`);
      setMessagesByChat((prev) => ({
        ...prev,
        [created.id]: prev[created.id] ?? [],
      }));
      return created;
    },
    [selectedMode, selectedModelId, selectedEffort, persistState],
  );

  const renameChat = React.useCallback(
    async (chatId: string, title: string) => {
      const updated = await apiClient.patchChat(chatId, { title });
      setChats((prev) => {
        const next = prev.map((c) => (c.id === chatId ? updated : c));
        persistState({ chats: next });
        return next;
      });
    },
    [persistState],
  );

  const togglePinChat = React.useCallback(
    async (chatId: string) => {
      const target = chats.find((c) => c.id === chatId);
      if (!target) return;
      const updated = await apiClient.patchChat(chatId, {
        pinned: !target.pinned,
      });
      setChats((prev) => {
        const next = prev
          .map((c) => (c.id === chatId ? updated : c))
          .sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
          );
        persistState({ chats: next });
        return next;
      });
    },
    [chats, persistState],
  );

  const deleteChats = React.useCallback(
    async (chatIds: string[]) => {
      await Promise.all(chatIds.map((id) => apiClient.deleteChat(id)));
      setChats((prev) => {
        const remaining = prev.filter((c) => !chatIds.includes(c.id));
        if (activeChatId && chatIds.includes(activeChatId)) {
          const fallback = remaining[0]?.id ?? null;
          state.activeChatIdRef.current = fallback;
          setActiveChatId(fallback);
        }
        persistState({ chats: remaining });
        return remaining;
      });
    },
    [activeChatId, persistState],
  );

  const toggleChatConnector = React.useCallback(
    async (chatId: string, connectorId: string, enabled: boolean) => {
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) return;
      const disabledSet = new Set(chat.disabledConnectorIds ?? []);
      if (enabled) disabledSet.delete(connectorId);
      else disabledSet.add(connectorId);
      const updated = await apiClient.patchChat(chatId, {
        disabledConnectorIds: Array.from(disabledSet),
      });
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    },
    [chats],
  );

  const setChatWebTools = React.useCallback(
    async (chatId: string, enabled: boolean) => {
      const updated = await apiClient.patchChat(chatId, { webToolsEnabled: enabled });
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    },
    [],
  );

  return {
    selectChat,
    createNewChat,
    renameChat,
    togglePinChat,
    deleteChats,
    toggleChatConnector,
    setChatWebTools,
  };
}
