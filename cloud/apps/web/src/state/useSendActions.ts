import { runErrorCopy } from '../lib/runErrorCopy';
import type { Chat, Message } from '@praxis/protocol';
import React from 'react';
import { toWireMode } from '../lib/modes';
import { isScriptedModel } from '../lib/models';
import { DEFAULT_MODEL_ID } from '@praxis/protocol';
import { apiClient, PraxisApiError } from '../lib/api';

import type { LiveRunState } from './types';
import type { PraxisState } from './usePraxisState';
import type { useRunStreams } from './useRunStreams';
export function useSendActions(
  state: PraxisState,
  {
    attachRunStream,
  }: ReturnType<typeof useRunStreams>,
) {
  const {
    onNavigate,
    setErrorBanner,
    setChats,
    activeChatId,
    setActiveChatId,
    setMessagesByChat,
    attachmentsById,
    setActiveSheet,
    selectedModelId,
    webSearch,
    selectedEffort,
    selectedMode,
    liveRunsByChat,
    setLiveRunsByChat,
  } = state;
  const resolveModel = React.useCallback(async () => {
    if (selectedModelId) return { modelId: selectedModelId };
    const page = await apiClient.listModels();
    return { modelId: page.items.find(m => m.id === DEFAULT_MODEL_ID)?.id ?? page.items[0]?.id };
  }, [selectedModelId]);
  const executeSendMessage = React.useCallback(
    async (
      text: string,
      options?: {
        regenerateMessageId?: string;
        attachmentIds?: string[];
        script?:
          | 'text'
          | 'tools'
          | 'approval'
          | 'nestedApproval'
          | 'elicitation'
          | 'error'
          | 'long'
          | 'compaction'
          | 'vision';
      },
    ): Promise<boolean> => {
      // Resolves false only when the connect card was opened instead of sending.
      setErrorBanner(null);
      state.pendingChatSwitchRef.current = null;
      let targetChatId = state.activeChatIdRef.current ?? activeChatId;
      const nowIso = new Date().toISOString();
      let createChatPromise: Promise<Chat> | null = null;
      let generatedChatId: string | null = null;

      if (!targetChatId) {
        const generatedId = crypto.randomUUID();
        generatedChatId = generatedId;
        targetChatId = generatedId;
        const wireMode = toWireMode(selectedMode);
        const optimisticChat: Chat = {
          type: 'chat',
          id: generatedId,
          title: 'New chat',
          pinned: false,
          mode: wireMode,
          connectorIds: [],
          disabledConnectorIds: [],
          createdAt: nowIso,
          updatedAt: nowIso,

          modelId: selectedModelId || undefined,
          effort: selectedEffort || undefined,
        };
        state.setDraftTitle('New chat');
        state.activeChatIdRef.current = generatedId;
        setActiveChatId(generatedId);
        setChats((prev) => [optimisticChat, ...prev.filter((c) => c.id !== generatedId)]);
        onNavigate?.(`/c/${encodeURIComponent(generatedId)}`);

        createChatPromise = resolveModel().then((pick) =>
          apiClient.createChat({
            id: generatedId,
            title: 'New chat',
            mode: wireMode,

            modelId: pick.modelId,
            effort: selectedEffort || undefined,
          }),
        );
        state.creatingChatPromisesRef.current.set(
          generatedId,
          createChatPromise.then(() => undefined, () => undefined),
        );
      }

      const clientTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      state.localTurnIdsRef.current.add(clientTurnId);
      const optimisticUserMsg: Message = {
        type: 'message',
        id: `optimistic-${clientTurnId}`,
        chatId: targetChatId,
        clientTurnId,
        role: 'user',
        parts: [
          { type: 'text', text },
          ...(options?.attachmentIds ?? []).map((attachmentId) => ({
            type: attachmentsById[attachmentId]?.mediaType.startsWith('image/')
              ? ('image' as const)
              : ('document' as const),
            attachmentId,
          })),
        ],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const optimisticRunId = `optimistic-run-${clientTurnId}`;
      const optimisticLiveRun: LiveRunState = {
        run: {
          type: 'run',
          id: optimisticRunId,
          chatId: targetChatId,
          clientTurnId,
          status: 'queued',
          promptStartedAt: options?.regenerateMessageId ? nowIso : undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastEventId: 0,
        },
        lastEventId: 0,
        textBlocks: [],
        reasoningBlocks: [],
        toolSteps: [],
        pendingApprovals: [],
        pendingElicitations: [],
        visionActivities: [],
        compactions: [],
      };

      const originalMessages = state.messagesByChat[targetChatId] ?? [];
      setMessagesByChat((prev) => ({
        ...prev,
        [targetChatId!]: options?.regenerateMessageId
          ? (prev[targetChatId!] ?? []).slice(
              0,
              (prev[targetChatId!] ?? []).findIndex((m) => m.id === options.regenerateMessageId),
            )
          : [...(prev[targetChatId!] ?? []), optimisticUserMsg],
      }));
      setLiveRunsByChat((prev) => ({
        ...prev,
        [targetChatId!]: optimisticLiveRun,
      }));

      let inferredScript = options?.script;
      if (!inferredScript && isScriptedModel(selectedModelId)) {
        const lower = text.toLowerCase();
        if (lower.includes('nested approval')) inferredScript = 'nestedApproval';
        else if (lower.includes('approval') || lower.includes('approve'))
          inferredScript = 'approval';
        else if (lower.includes('elicitation') || lower.includes('clarify'))
          inferredScript = 'elicitation';
        else if (lower.includes('tool') || lower.includes('table') || lower.includes('search'))
          inferredScript = 'tools';
        else if (lower.includes('vision') || (options?.attachmentIds?.length ?? 0) > 0)
          inferredScript = 'vision';
        else if (lower.includes('compact')) inferredScript = 'compaction';
        else if (lower.includes('error')) inferredScript = 'error';
      }

      try {
        if (typeof performance !== 'undefined') {
          performance.mark('praxis:run-start');
        }
        if (createChatPromise && generatedChatId) {
          try {
            const created = await createChatPromise;
            if (created.id !== generatedChatId) {
              const oldId = generatedChatId;
              targetChatId = created.id;
              if (state.activeChatIdRef.current === oldId) {
                state.activeChatIdRef.current = created.id;
                setActiveChatId(created.id);
                onNavigate?.(`/c/${encodeURIComponent(created.id)}`);
              }
              setMessagesByChat((prev) => {
                const { [oldId]: moved = [], ...rest } = prev;
                return {
                  ...rest,
                  [created.id]: moved.map((m) => (m.chatId === oldId ? { ...m, chatId: created.id } : m)),
                };
              });
              setLiveRunsByChat((prev) => {
                const moved = prev[oldId];
                if (!moved) return prev;
                const { [oldId]: _, ...rest } = prev;
                return {
                  ...rest,
                  [created.id]: { ...moved, run: { ...moved.run, chatId: created.id } },
                };
              });
              setChats((prev) => [created, ...prev.filter((c) => c.id !== oldId && c.id !== created.id)]);
            } else {
              setChats((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
            }
          } finally {
            state.creatingChatPromisesRef.current.delete(generatedChatId);
          }
        }
        const pick = await resolveModel();
        const run = await apiClient.startRun({
          regenerateMessageId: options?.regenerateMessageId,
          chatId: targetChatId,
          text,

          modelId: pick.modelId,
          mode: toWireMode(selectedMode),
          effort: selectedEffort,
          webSearch,
          attachmentIds: options?.attachmentIds ?? [],
          clientTurnId,
          idempotencyKey: clientTurnId,
          script: inferredScript,
        });

        if (state.cancelledTurnIdsRef.current.delete(clientTurnId)) {
          setLiveRunsByChat((prev) => {
            const current = prev[targetChatId!];
            if (!current || current.run.id !== optimisticRunId) return prev;
            return {
              ...prev,
              [targetChatId!]: { ...current, run: { ...run, status: 'cancelled' } },
            };
          });
          void apiClient.cancelRun(run.id).catch(() => {});
          void apiClient
            .getChat(targetChatId)
            .then((chat) =>
              setChats((prev) => prev.map((value) => (value.id === chat.id ? chat : value))),
            )
            .catch(() => {});
          return true;
        }

        setLiveRunsByChat((prev) => {
          const current = prev[targetChatId!];
          if (current && current.run.id === optimisticRunId) {
            return { ...prev, [targetChatId!]: { ...current, run } };
          }
          return {
            ...prev,
            [targetChatId!]: {
              run,
              lastEventId: 0,
              textBlocks: [],
              reasoningBlocks: [],
              toolSteps: [],
              pendingApprovals: [],
              pendingElicitations: [],
              visionActivities: [],
              compactions: [],
            },
          };
        });

        void apiClient
          .getChat(targetChatId)
          .then((chat) =>
            setChats((prev) => prev.map((value) => (value.id === chat.id ? chat : value))),
          )
          .catch((err) =>
            setErrorBanner(err instanceof Error ? err.message : 'Unable to refresh title'),
          );
        attachRunStream(run, 0);
        return true;
      } catch (err) {
        if (options?.regenerateMessageId) {
          setMessagesByChat((prev) => ({ ...prev, [targetChatId!]: originalMessages }));
        }
        setLiveRunsByChat((prev) => {
          const current = prev[targetChatId!];
          if (!current || current.run.id !== optimisticRunId) return prev;
          const next = { ...prev };
          delete next[targetChatId!];
          return next;
        });
        if (err instanceof PraxisApiError && err.code === 'model_key_missing') {
          state.setModelKey(null);
          setActiveSheet('models');
          setMessagesByChat(prev => ({...prev, [targetChatId!]: originalMessages}));
          return false;
        }
        const msg = runErrorCopy(err);
        setErrorBanner(msg);
        return true;
      }
    },
    [
      activeChatId,
      onNavigate,
      attachmentsById,
      selectedModelId,
      selectedMode,
      selectedEffort,
      webSearch,
      attachRunStream,
      resolveModel,
    ],
  );

  const cancelActiveRun = React.useCallback(async () => {
    const chatId = state.activeChatIdRef.current ?? activeChatId;
    if (!chatId) return;
    const live = liveRunsByChat[chatId];
    if (!live) return;
    if (live.run.id.startsWith('optimistic-run-')) {
      if (live.run.clientTurnId) {
        state.cancelledTurnIdsRef.current.add(live.run.clientTurnId);
      }
      setLiveRunsByChat((prev) => {
        const current = prev[chatId];
        if (!current || current.run.id !== live.run.id) return prev;
        return {
          ...prev,
          [chatId]: { ...current, run: { ...current.run, status: 'cancelled' } },
        };
      });
      return;
    }
    await apiClient.cancelRun(live.run.id);
  }, [activeChatId, liveRunsByChat]);

  const resolveApproval = React.useCallback(
    async (runId: string, approvalId: string, decision: 'allowOnce' | 'allowAlways' | 'deny') => {
      await apiClient.submitApproval(runId, approvalId, decision);
    },
    [],
  );

  const resolveElicitation = React.useCallback(
    async (
      runId: string,
      elicitationId: string,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>,
    ) => {
      await apiClient.submitElicitation(runId, elicitationId, action, content);
    },
    [],
  );

  return {
    executeSendMessage,
    cancelActiveRun,
    resolveApproval,
    resolveElicitation,
  };
}
