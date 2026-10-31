import type { Message } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../lib/api';

import type { useChatActions } from './useChatActions';
import type { PraxisState } from './usePraxisState';
import type { useRunStreams } from './useRunStreams';
export function useSendActions(
  state: PraxisState,
  {
    createNewChat,
    attachRunStream,
  }: Pick<ReturnType<typeof useChatActions>, 'createNewChat'> & ReturnType<typeof useRunStreams>,
) {
  const {
    setErrorBanner,
    chats,
    setChats,
    activeChatId,
    setMessagesByChat,
    models,
    attachmentsById,
    selectedProviderId,
    selectedModelId,
    webSearch,
    selectedEffort,
    selectedMode,
    liveRunsByChat,
    setLiveRunsByChat,
  } = state;
  const executeSendMessage = React.useCallback(
    async (
      text: string,
      options?: {
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
    ) => {
      setErrorBanner(null);
      let targetChatId = activeChatId;
      if (!targetChatId) {
        const created = await createNewChat('New chat');
        targetChatId = created.id;
      }

      const clientTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();
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

      setMessagesByChat((prev) => ({
        ...prev,
        [targetChatId!]: [...(prev[targetChatId!] ?? []), optimisticUserMsg],
      }));

      // Infer script in local mode from prompt keywords if not explicitly provided
      let inferredScript = options?.script;
      if (!inferredScript && selectedProviderId === 'scripted') {
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
        const run = await apiClient.startRun({
          chatId: targetChatId,
          text,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          mode: selectedMode,
          effort: selectedEffort,
          webSearch:
            webSearch &&
            !!models.find((m) => m.id === selectedModelId && m.providerId === selectedProviderId)
              ?.capabilities.serverWebSearch,
          attachmentIds: options?.attachmentIds ?? [],
          clientTurnId,
          idempotencyKey: clientTurnId,
          script: inferredScript,
        });

        setLiveRunsByChat((prev) => ({
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
        }));

        void apiClient
          .getChat(targetChatId)
          .then((chat) =>
            setChats((prev) => prev.map((value) => (value.id === chat.id ? chat : value))),
          )
          .catch((err) =>
            setErrorBanner(err instanceof Error ? err.message : 'Unable to refresh title'),
          );
        attachRunStream(run, 0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to start run';
        setErrorBanner(msg);
      }
    },
    [
      activeChatId,
      createNewChat,
      chats,
      attachmentsById,
      selectedProviderId,
      selectedModelId,
      selectedMode,
      selectedEffort,
      webSearch,
      models,
      attachRunStream,
    ],
  );

  const cancelActiveRun = React.useCallback(async () => {
    if (!activeChatId) return;
    const live = liveRunsByChat[activeChatId];
    if (!live) return;
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
