import React from 'react';
import { GlassChip, ProgressiveBlurScrim } from '@praxis/glass';
import { ArrowDown } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import { AssistantTurn, groupTranscript, OutcomeNote, UnansweredTurn } from './AssistantTurn';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { UserBubble } from './UserBubble';
import styles from './ChatScreen.module.css';

const RUNNING_STATUSES = ['queued', 'running', 'awaitingApproval', 'awaitingElicitation', 'continuing'];

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

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight > 160;
    setShowJumpToLatest((prev) => (prev === next ? prev : next));
  };

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  React.useEffect(() => {
    scrollToBottom('auto');
  }, [activeChat?.id, scrollToBottom]);

  const status = activeLiveRun?.run.status;
  const isRunning = !!status && RUNNING_STATUSES.includes(status);
  // A stopped or failed run stays on screen with its note: neither saves an answer of its own.
  const hasLiveStreamingContent = isRunning || status === 'failed' || status === 'cancelled';
  const isEmpty = activeMessages.length === 0 && !hasLiveStreamingContent;
  const transcript = React.useMemo(
    () => groupTranscript(activeMessages, hasLiveStreamingContent ? activeLiveRun?.run.id : undefined),
    [activeMessages, hasLiveStreamingContent, activeLiveRun?.run.id],
  );
  const retryLast = () => {
    const last = [...activeMessages].reverse().find((m) => m.role === 'user');
    const text = last?.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
    if (text) void sendMessage(text);
  };

  return (
    <main data-testid="chat-screen" className={styles.screen}>
      <ProgressiveBlurScrim edge="top" height={72} />
      <ChatHeader />

      <div ref={scrollRef} data-testid="chat-scroll-viewport" onScroll={handleScroll} className={styles.viewport}>
        <div className={styles.column} data-empty={isEmpty}>
          {errorBanner ? (
            <div role="alert" data-testid="chat-error-banner" className={styles.error}>
              <span>{errorBanner}</span>
              <button type="button" onClick={clearErrorBanner}>
                Dismiss
              </button>
            </div>
          ) : null}

          {isEmpty ? (
            <EmptyState onPick={(prompt, script) => void sendMessage(prompt, { script })} />
          ) : (
            transcript.map((item) =>
              item.kind === 'user' ? (
                <UserBubble key={item.key} message={item.message} attachmentsById={attachmentsById} />
              ) : item.kind === 'assistant' ? (
                <AssistantTurn key={item.key} messages={item.messages} onRetry={retryLast} />
              ) : (
                <UnansweredTurn key={item.key} runId={item.runId} />
              ),
            )
          )}

          {hasLiveStreamingContent && activeLiveRun ? (
            <div data-testid="live-run-streaming-turn" className={styles.assistantTurn}>
              <AgentActivityView
                startedAt={activeLiveRun.run.createdAt}
                finishedAt={activeLiveRun.run.updatedAt}
                runId={activeLiveRun.run.id}
                isRunning={isRunning}
                isStopped={status === 'cancelled'}
                reasoningBlocks={activeLiveRun.reasoningBlocks}
                toolSteps={activeLiveRun.toolSteps}
                pendingApprovals={isRunning ? activeLiveRun.pendingApprovals : []}
                pendingElicitations={isRunning ? activeLiveRun.pendingElicitations : []}
                visionActivities={activeLiveRun.visionActivities}
                compactions={activeLiveRun.compactions}
                onResolveApproval={(rId, aId, decision) => void resolveApproval(rId, aId, decision)}
                onResolveElicitation={(rId, eId, action, content) =>
                  void resolveElicitation(rId, eId, action, content)
                }
              />
              {activeLiveRun.textBlocks.length > 0 ? (
                <AgentMessageView
                  text={activeLiveRun.textBlocks.map((b) => b.text).join('\n\n')}
                  isStreaming={isRunning}
                  usage={activeLiveRun.usage}
                />
              ) : null}
              <OutcomeNote run={activeLiveRun.run} />
            </div>
          ) : null}
        </div>
      </div>

      <ProgressiveBlurScrim edge="bottom" height={112} />

      {showJumpToLatest ? (
        <div className={styles.jump}>
          <GlassChip
            data-testid="jump-to-latest-button"
            icon={<ArrowDown size={16} />}
            onClick={() => scrollToBottom('smooth')}
          >
            Jump to latest
          </GlassChip>
        </div>
      ) : null}

      <div className={styles.dock}>
        <Composer />
      </div>
    </main>
  );
}
