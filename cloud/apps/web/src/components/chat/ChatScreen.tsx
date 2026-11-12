import {runErrorCopy} from '../../lib/runErrorCopy';
import React from 'react';
import type { Message } from '@praxis/protocol';
import { GlassChip, PANEL, ProgressiveBlurScrim } from '@praxis/glass';
import { motion } from 'framer-motion';
import { ArrowDown } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { AgentActivityView } from './AgentActivityView';
import {useStreamAnchor} from './useStreamAnchor';
import { AgentMessageView } from './AgentMessageView';
import { useContentShift } from '../shell/useContentShift';
import { ChatHeader } from './ChatHeader';
import { cancelSendFlight, useMessageArrival } from './chatMotion';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { extractMessageToolSteps } from './messageTools';
import { MessageActivity } from './MessageActivity';
import {messageTurns} from './messageTurns';
import { UserBubble } from './UserBubble';
import { RunBackdrop } from './RunBackdrop';
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
    .join(joiner);
}

export function ChatScreen() {
  const {
    activeChat,
    activeMessages,
    activeLiveRun,
    attachmentsById,
    errorBanner,
    clearErrorBanner,
    sendMessage,
    resolveApproval,
    resolveElicitation,
  } = usePraxisStore();

  const visibleMessages=React.useMemo(()=>messageTurns(activeMessages),[activeMessages]);
  const lastUserMessage = React.useMemo(
    () => [...visibleMessages].reverse().find((m) => m.role === 'user'),
    [visibleMessages],
  );
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const shift = useContentShift();
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const {onScroll:handleScroll,jumpToLatest:scrollToBottom,showJump:showJumpToLatest}=useStreamAnchor(scrollRef,columnRef,activeChat?.id, lastUserMessage?.clientTurnId ?? lastUserMessage?.id, lastUserMessage?.id.startsWith('optimistic-'));

  const status = activeLiveRun?.run.status;
  // A run that just completed keeps its live turn for one fold, so a thought that is still folding away
  // finishes in place instead of snapping shut when the saved message takes over (WP-K2 item 1).
  const runId = activeLiveRun?.run.id;
  const [lingerRunId, setLingerRunId] = React.useState<string | undefined>();
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (status === 'running') wasRunning.current = true;
    if (status !== 'completed' || !wasRunning.current || !runId) return;
    wasRunning.current = false;
    setLingerRunId(runId);
    const id = window.setTimeout(() => setLingerRunId(undefined), FOLD_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [status, runId]);
  const hasLiveStreamingContent =
    !!activeLiveRun &&
    ((status === 'completed' && lingerRunId === runId) ||
      status === 'running' ||
      status === 'awaitingApproval' ||
      status === 'awaitingElicitation' ||
      status === 'failed' ||
      status === 'cancelled');
  const isEmpty = activeMessages.length === 0 && !hasLiveStreamingContent;
  const error = errorBanner || activeLiveRun?.run.error;
  React.useEffect(() => {
    if (error) cancelSendFlight();
  }, [error]);
  const prevChatIdRef = React.useRef<string | undefined>(activeChat?.id);
  React.useEffect(() => {
    if (prevChatIdRef.current && activeChat?.id && prevChatIdRef.current !== activeChat.id) {
      cancelSendFlight();
    }
    prevChatIdRef.current = activeChat?.id;
  }, [activeChat?.id]);
  React.useEffect(() => () => cancelSendFlight(), []);

  const liveRunId = hasLiveStreamingContent ? activeLiveRun?.run.id : undefined;
  const arrivalKeys = React.useMemo(() => {
    const keys = visibleMessages.map((m) =>
      m.role === 'user' ? `m:${m.clientTurnId ?? m.id}` : `r:${m.runId ?? m.id}`,
    );
    if (liveRunId) keys.push(`r:${liveRunId}`);
    return keys;
  }, [visibleMessages, liveRunId]);
  useMessageArrival(columnRef, activeChat?.id, arrivalKeys);

  return (
    <main data-testid="chat-screen" className={styles.screen}>
      <RunBackdrop active={status === 'running'} />
      {/* The blur bands follow the column (Chromium mirrors scrolled text into a blur reaching past its edge);
          the paper tint stays full-width so the lane has no visible edge. */}
      <motion.div className={styles.scrimLane} aria-hidden="true" initial={false} animate={{ x: shift }} transition={PANEL}>
        {/* WP-K2 (K-ref/13): one ramp from the very top to just past the title's baseline, strongest at the edge;
            the title sits on the blur with no box. The composer's ramp matches it. */}
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
                hasLiveStreamingContent &&
                msg.runId === activeLiveRun?.run.id
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
              const hasReasoning = msg.parts.some((p) => p.type === 'reasoning');
              const text = messageText(msg, '\n\n');
              const live = activeLiveRun?.run.id === msg.runId ? activeLiveRun : undefined;
              let promptStartedAt: string | undefined;
              for (let i = index - 1; i >= 0; i--) {
                if (visibleMessages[i]?.role === 'user') {
                  promptStartedAt = visibleMessages[i]?.createdAt;
                  break;
                }
              }
              return (
                <div
                  key={msg.id}
                  data-testid="assistant-turn"
                  data-message-key={`r:${msg.runId ?? msg.id}`}
                  className={styles.assistantTurn}
                >
                  {steps.length > 0 || hasReasoning ? (
                    <MessageActivity
                      message={msg}
                      steps={steps}
                      liveRun={live?.run}
                      liveSteps={live?.toolSteps}
                      promptStartedAt={promptStartedAt}
                    />
                  ) : null}
                  {text ? (
                    <AgentMessageView
                      text={text}
                      onRetry={() => {
                        const user=visibleMessages.slice(0,index).reverse().find(m=>m.role==='user');
                        if(user)void sendMessage(messageText(user,' '),{regenerateMessageId:msg.id});
                      }}
                    />
                  ) : null}
                </div>
              );
            })
          )}

          {hasLiveStreamingContent && activeLiveRun ? (
            <div
              data-testid="live-run-streaming-turn"
              data-message-key={`r:${activeLiveRun.run.id}`}
              className={styles.assistantTurn}
            >
              <AgentActivityView
                startedAt={activeLiveRun.run.createdAt}
                finishedAt={activeLiveRun.run.updatedAt}
                promptStartedAt={lastUserMessage?.createdAt}
                runId={activeLiveRun.run.id}
                isRunning={status === 'running'}
                runStatus={status}
                reasoningBlocks={activeLiveRun.reasoningBlocks}
                toolSteps={activeLiveRun.toolSteps}
                pendingApprovals={activeLiveRun.pendingApprovals}
                pendingElicitations={activeLiveRun.pendingElicitations}
                visionActivities={activeLiveRun.visionActivities}
                compactions={activeLiveRun.compactions}
                onResolveApproval={(rId, aId, decision) => void resolveApproval(rId, aId, decision)}
                onResolveElicitation={(rId, eId, action, content) =>
                  resolveElicitation(rId, eId, action, content)
                }
              />
              {activeLiveRun.run.error ? <p role="alert" data-testid="chat-error-banner" className={styles.error}>Couldn't finish: {runErrorCopy(activeLiveRun.run.error)}</p> : null}
              {activeLiveRun.textBlocks.length > 0 ? (
                <AgentMessageView
                  text={activeLiveRun.textBlocks.map((b) => b.text).join('\n\n')}
                  isStreaming={status === 'running'}
                  usage={activeLiveRun.usage}
                />
              ) : null}
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
