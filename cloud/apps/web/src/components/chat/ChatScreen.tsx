import React from 'react';
import type { Message } from '@praxis/protocol';
import { GlassChip, ProgressiveBlurScrim } from '@praxis/glass';
import { ArrowDown } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { extractMessageToolSteps } from './messageTools';
import { MessageActivity } from './MessageActivity';
import { UserBubble } from './UserBubble';
import styles from './ChatScreen.module.css';

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
  const hasLiveStreamingContent =
    !!activeLiveRun &&
    (status === 'running' ||
      status === 'awaitingApproval' ||
      status === 'awaitingElicitation' ||
      status === 'failed');
  const isEmpty = activeMessages.length === 0 && !hasLiveStreamingContent;
  const lastUserText = () => {
    const last = [...activeMessages].reverse().find((m) => m.role === 'user');
    return last ? messageText(last, '\n') : '';
  };
  const error = errorBanner || activeLiveRun?.run.error;

  return (
    <main data-testid="chat-screen" className={styles.screen}>
      <ProgressiveBlurScrim edge="top" height={72} />
      <ChatHeader />

      <div ref={scrollRef} data-testid="chat-scroll-viewport" onScroll={handleScroll} className={styles.viewport}>
        <div className={styles.column} data-empty={isEmpty}>
          {error ? (
            <div role="alert" data-testid="chat-error-banner" className={styles.error}>
              <span>{error}</span>
              <button type="button" onClick={clearErrorBanner}>
                Dismiss
              </button>
            </div>
          ) : null}

          {isEmpty ? (
            <EmptyState onPick={(prompt, script) => void sendMessage(prompt, { script })} />
          ) : (
            activeMessages.map((msg) => {
              if (msg.role === 'assistant' && hasLiveStreamingContent && msg.runId === activeLiveRun?.run.id)
                return null;
              if (msg.role === 'user')
                return <UserBubble key={msg.id} message={msg} attachmentsById={attachmentsById} />;
              const steps = extractMessageToolSteps(msg);
              const hasReasoning = msg.parts.some((p) => p.type === 'reasoning');
              const text = messageText(msg, '\n\n');
              const live = activeLiveRun?.run.id === msg.runId ? activeLiveRun : undefined;
              return (
                <div key={msg.id} data-testid="assistant-turn" className={styles.assistantTurn}>
                  {steps.length > 0 || hasReasoning ? (
                    <MessageActivity message={msg} steps={steps} liveRun={live?.run} liveSteps={live?.toolSteps} />
                  ) : null}
                  {text ? (
                    <AgentMessageView
                      text={text}
                      onRetry={() => {
                        const retry = lastUserText();
                        if (retry) void sendMessage(retry);
                      }}
                    />
                  ) : null}
                </div>
              );
            })
          )}

          {hasLiveStreamingContent && activeLiveRun ? (
            <div data-testid="live-run-streaming-turn" className={styles.assistantTurn}>
              <AgentActivityView
                startedAt={activeLiveRun.run.createdAt}
                finishedAt={activeLiveRun.run.updatedAt}
                runId={activeLiveRun.run.id}
                isRunning={status === 'running'}
                reasoningBlocks={activeLiveRun.reasoningBlocks}
                toolSteps={activeLiveRun.toolSteps}
                pendingApprovals={activeLiveRun.pendingApprovals}
                pendingElicitations={activeLiveRun.pendingElicitations}
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
                  isStreaming={status === 'running'}
                  usage={activeLiveRun.usage}
                />
              ) : null}
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
