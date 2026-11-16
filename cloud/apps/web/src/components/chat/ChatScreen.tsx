import {runErrorCopy} from '../../lib/runErrorCopy';
import React from 'react';
import type { Message } from '@praxis/protocol';
import { GlassChip, PANEL, ProgressiveBlurScrim } from '@praxis/glass';
import { motion } from 'framer-motion';
import { ArrowDown } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { useSmoothText } from './smoothText';
import {useStreamAnchor} from './useStreamAnchor';
import { useContentShift } from '../shell/useContentShift';
import { ChatHeader } from './ChatHeader';
import {
  cancelSendFlight,
  useChatSwitchEntrance,
  useMessageArrival,
  useSendFlightActive,
} from './chatMotion';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { extractMessageToolSteps } from './messageTools';
import { MessageActivity } from './MessageActivity';
import {messageTurns} from './messageTurns';
import { hasThought } from './ReasoningView';
import { LiveResponseTimeline } from './ResponseTimeline';
import { UserBubble } from './UserBubble';
import { RunBackdrop } from './RunBackdrop';
import { useSearchJump } from './useSearchJump';
import styles from './ChatScreen.module.css';

/** The header bar's height (--topbar-height + --float-margin): the top ramp ends just past the title. */
const SCRIM_TOP = 72;
/** The dock's height, so the composer's ramp reaches as far past its top edge as the header's does. */
const SCRIM_BOTTOM = 88;
const SCRIM_BLUR = 10;
/** A little over --fold-duration (320 ms). */
const FOLD_LINGER_MS = 360;
/** A light paper feather: legibility without a white band. */
const SCRIM_TINT = 0.6;

function messageText(message: Message, joiner: string) {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join(joiner);
}

export function ChatScreen() {
  const {
    activeChat,
    activeChatId,
    activeMessages,
    activeLiveRun,
    attachmentsById,
    errorBanner,
    clearErrorBanner,
    pendingChatSwitchRef,
    sendMessage,
    resolveApproval,
    resolveElicitation,
  } = usePraxisStore();

  const chatId = activeChat?.id ?? activeChatId ?? undefined;
  const visibleMessages=React.useMemo(()=>messageTurns(activeMessages),[activeMessages]);
  const lastUserIndex = React.useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i]?.role === 'user') return i;
    }
    return -1;
  }, [visibleMessages]);
  const lastUserMessage = lastUserIndex >= 0 ? visibleMessages[lastUserIndex] : undefined;
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const shift = useContentShift();
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const {onScroll:handleScroll,jumpToLatest:scrollToBottom,showJump:showJumpToLatest}=useStreamAnchor(scrollRef,columnRef,chatId, lastUserMessage?.clientTurnId ?? lastUserMessage?.id, lastUserMessage?.id.startsWith('optimistic-'));

  const flightActive = useSendFlightActive();
  const status = activeLiveRun?.run.status;
  const runId = activeLiveRun?.run.id;
  const [inspectedRunId, setInspectedRunId] = React.useState<string>();
  React.useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const preserve = (event: MouseEvent) => {
      if ((event.target as Element).closest('[aria-expanded]')?.closest('[data-testid="live-run-streaming-turn"]')) setInspectedRunId(runId);
    };
    viewport?.addEventListener('click', preserve, true);
    return () => viewport?.removeEventListener('click', preserve, true);
  }, [runId]);
  const liveHasFoldableActivity =
    !!activeLiveRun &&
    (activeLiveRun.toolSteps.length > 0 ||
      activeLiveRun.reasoningBlocks.some(hasThought) ||
      activeLiveRun.visionActivities.length > 0 ||
      activeLiveRun.compactions.length > 0 ||
      activeLiveRun.pendingApprovals.length > 0 ||
      activeLiveRun.pendingElicitations.length > 0);
  const receivedText = activeLiveRun?.textBlocks.map(b => b.text).join('') ?? '';
  // A provider can finish a text block and then spend seconds in a tool. Reveal its last word now.
  const textIsStreaming = (status === 'running' || status === 'queued') && !activeLiveRun?.textBlocks.at(-1)?.finished;
  const pacedText = useSmoothText(flightActive ? '' : receivedText, textIsStreaming, runId);
  const draining = pacedText.length < receivedText.length;
  let revealBudget = pacedText.length;
  const pacedLiveRun = activeLiveRun ? {
    ...activeLiveRun,
    textBlocks: activeLiveRun.textBlocks.map(block => {
      const text = block.text.slice(0, Math.max(0, revealBudget));
      revealBudget -= block.text.length;
      return { ...block, text };
    }),
  } : undefined;
  const savedForLiveRun =
    !!runId && visibleMessages.some((m) => m.role === 'assistant' && m.runId === runId);
  const [lingerRunId, setLingerRunId] = React.useState<string | undefined>();
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (status === 'queued' || status === 'running') wasRunning.current = true;
    if (status !== 'completed' || !wasRunning.current || !runId) return;
    wasRunning.current = false;
    if (!liveHasFoldableActivity && savedForLiveRun) {
      setLingerRunId(undefined);
      return;
    }
    setLingerRunId(runId);
    const id = window.setTimeout(() => setLingerRunId(undefined), FOLD_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [status, runId, liveHasFoldableActivity, savedForLiveRun]);
  const shouldLinger =
    status === 'completed' &&
    lingerRunId === runId &&
    (liveHasFoldableActivity || !savedForLiveRun);
  const hasLiveStreamingContent =
    !!activeLiveRun &&
    (draining || shouldLinger || (status === 'completed' && inspectedRunId === runId) ||
      status === 'queued' ||
      status === 'running' ||
      status === 'awaitingApproval' ||
      status === 'awaitingElicitation' ||
      status === 'failed' ||
      status === 'cancelled');
  const showLiveTurn = !flightActive && hasLiveStreamingContent && !!activeLiveRun;
  const isEmpty = activeMessages.length === 0 && !hasLiveStreamingContent;
  const error = errorBanner || activeLiveRun?.run.error;
  React.useEffect(() => {
    if (error) cancelSendFlight();
  }, [error]);
  const prevChatIdRef = React.useRef<string | undefined>(chatId);
  React.useEffect(() => {
    if (prevChatIdRef.current && chatId && prevChatIdRef.current !== chatId) {
      cancelSendFlight();
    }
    prevChatIdRef.current = chatId;
  }, [chatId]);
  React.useEffect(() => () => cancelSendFlight(), []);

  const liveTurnKey = showLiveTurn
    ? (activeLiveRun?.run.clientTurnId ?? activeLiveRun?.run.id)
    : undefined;
  const arrivalKeys = React.useMemo(() => {
    const keys: string[] = [];
    visibleMessages.forEach((m, index) => {
      if (m.role === 'assistant' && flightActive && index > lastUserIndex) return;
      keys.push(
        m.role === 'user' ? `m:${m.clientTurnId ?? m.id}` : `r:${m.clientTurnId ?? m.runId ?? m.id}`,
      );
    });
    if (liveTurnKey) {
      const rk = `r:${liveTurnKey}`;
      if (!keys.includes(rk)) keys.push(rk);
    }
    return keys;
  }, [visibleMessages, flightActive, lastUserIndex, liveTurnKey]);
  useMessageArrival(columnRef, chatId, arrivalKeys);
  useChatSwitchEntrance(columnRef, scrollRef, chatId, pendingChatSwitchRef, visibleMessages.length);
  useSearchJump(scrollRef, columnRef, chatId, visibleMessages, pendingChatSwitchRef);

  const liveText = activeLiveRun
    ? activeLiveRun.textBlocks.map((b) => b.text).filter(Boolean).join('\n\n')
    : '';
  const liveSavedMsg = React.useMemo(
    () => (runId ? visibleMessages.find((m) => m.role === 'assistant' && m.runId === runId) : undefined),
    [visibleMessages, runId],
  );

  return (
    <main data-testid="chat-screen" className={styles.screen}>
      <RunBackdrop active={status === 'queued' || status === 'running'} />
      <motion.div className={styles.scrimLane} aria-hidden="true" initial={false} animate={{ x: shift }} transition={PANEL}>
        <ProgressiveBlurScrim edge="top" height={SCRIM_TOP} maxBlur={SCRIM_BLUR} layers="blur" />
        <ProgressiveBlurScrim edge="bottom" height={SCRIM_BOTTOM} maxBlur={SCRIM_BLUR} layers="blur" />
      </motion.div>
      <ProgressiveBlurScrim edge="top" height={SCRIM_TOP} tintStrength={SCRIM_TINT} layers="tint" />
      <ChatHeader />

      <div
        ref={scrollRef}
        data-testid="chat-scroll-viewport"
        onScroll={handleScroll}
        className={styles.viewport}
      >
        <motion.div
          ref={columnRef}
          data-chat-column=""
          className={styles.column}
          data-empty={isEmpty}
          initial={false}
          animate={{ x: shift }}
          transition={PANEL}
        >
          {error && !activeLiveRun?.run.error ? (
            <div role="alert" data-testid="chat-error-banner" className={styles.error}>
              <span>Couldn't finish: {error}</span>
              <button type="button" onClick={clearErrorBanner}>
                Dismiss
              </button>
            </div>
          ) : null}

          {isEmpty ? (
            <EmptyState onPick={(prompt, script) => void sendMessage(prompt, { script })} />
          ) : (
            visibleMessages.map((msg, index) => {
              if (
                msg.role === 'assistant' &&
                ((hasLiveStreamingContent && msg.runId === activeLiveRun?.run.id) ||
                  (flightActive && index > lastUserIndex))
              )
                return null;
              if (msg.role === 'user')
                return (
                  <UserBubble
                    key={msg.clientTurnId ?? msg.id}
                    message={msg}
                    attachmentsById={attachmentsById}
                  />
                );
              const steps = extractMessageToolSteps(msg);
              const text = messageText(msg, '\n\n');
              const live = activeLiveRun?.run.id === msg.runId ? activeLiveRun : undefined;
              let promptStartedAt: string | undefined;
              for (let i = index - 1; i >= 0; i--) {
                if (visibleMessages[i]?.role === 'user') {
                  promptStartedAt = msg.promptStartedAt ?? visibleMessages[i]?.createdAt;
                  break;
                }
              }
              return (
                <div
                  key={msg.id}
                  data-testid="assistant-turn"
                  data-message-key={`r:${msg.clientTurnId ?? msg.runId ?? msg.id}`}
                  className={styles.assistantTurn}
                >
                  <MessageActivity
                    message={msg}
                    steps={steps}
                    text={text}
                    liveRun={live?.run}
                    liveSteps={live?.toolSteps}
                    promptStartedAt={promptStartedAt}
                    onRetry={
                      text.trim().length > 0
                        ? () => {
                            const user = visibleMessages
                              .slice(0, index)
                              .reverse()
                              .find((m) => m.role === 'user');
                            if (user) {
                              void sendMessage(messageText(user, ' '), {
                                regenerateMessageId: msg.id,
                              });
                            }
                          }
                        : undefined
                    }
                  />
                </div>
              );
            })
          )}

          {showLiveTurn ? (
            <div
              data-testid="live-run-streaming-turn"
              data-message-key={`r:${liveTurnKey}`}
              className={styles.assistantTurn}
            >
              <LiveResponseTimeline
                live={pacedLiveRun!}
                revealing={draining}
                promptStartedAt={activeLiveRun.run.promptStartedAt ?? lastUserMessage?.createdAt}
                onRetry={
                  liveText.trim().length > 0 && lastUserMessage
                    ? () => {
                        void sendMessage(messageText(lastUserMessage, ' '), {
                          regenerateMessageId: liveSavedMsg?.id,
                        });
                      }
                    : undefined
                }
                errorElement={
                  activeLiveRun.run.error ? (
                    <p role="alert" data-testid="chat-error-banner" className={styles.error}>
                      Couldn't finish: {runErrorCopy(activeLiveRun.run.error)}
                    </p>
                  ) : undefined
                }
                onResolveApproval={(rId, aId, decision) => void resolveApproval(rId, aId, decision)}
                onResolveElicitation={(rId, eId, action, content) =>
                  resolveElicitation(rId, eId, action, content)
                }
              />
            </div>
          ) : null}
        </motion.div>
      </div>

      <ProgressiveBlurScrim edge="bottom" height={SCRIM_BOTTOM} tintStrength={SCRIM_TINT} layers="tint" />

      <motion.div className={styles.jump} data-visible={showJumpToLatest} aria-hidden={!showJumpToLatest} inert={!showJumpToLatest} initial={false} animate={{ x: shift }} transition={PANEL}>
        <GlassChip data-testid="jump-to-latest-button" icon={<ArrowDown size={16}/>} onClick={()=>scrollToBottom('smooth')}>
          Jump to latest
        </GlassChip>
      </motion.div>

      <motion.div className={styles.dock} initial={false} animate={{ x: shift }} transition={PANEL}>
        <Composer />
      </motion.div>
    </main>
  );
}
