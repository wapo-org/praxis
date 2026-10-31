import { extractMessageToolSteps } from './messageTools';
import { MessageActivity } from './MessageActivity';
import React from 'react';
import type { Message } from '@praxis/protocol';
import { GlassChip, ProgressiveBlurScrim } from '@praxis/glass';
import { usePraxisStore, type ActiveToolStep } from '../../state/store';
import { UserBubble } from './UserBubble';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';

export interface ChatScreenProps {
  onOpenGlassLab?: () => void;
}

const STARTER_SUGGESTIONS: Array<{
  label: string;
  prompt: string;
  script?: 'text' | 'tools' | 'approval' | 'elicitation';
}> = [
  {
    label: 'Editorial note on liquid glass',
    prompt: 'Write a concise editorial note on Snell’s law refraction in liquid glass UI.',
    script: 'text',
  },
  {
    label: 'Search workspace & build table',
    prompt: 'Search the workspace with tools and summarize the findings in a GFM table.',
    script: 'tools',
  },
  {
    label: 'Test tool approval flow',
    prompt: 'Run a shell command that requires tool approval before executing.',
    script: 'approval',
  },
  {
    label: 'Ask clarifying question',
    prompt: 'Start an elicitation form to clarify deployment parameters.',
    script: 'elicitation',
  },
];

export const ChatScreen: React.FC<ChatScreenProps> = ({ onOpenGlassLab }) => {
  const {
    activeChat,
    activeMessages,
    activeLiveRun,
    attachmentsById,
    models,
    selectedProviderId,
    selectedModelId,
    errorBanner,
    clearErrorBanner,
    setActiveSheet,
    createNewChat,
    sendMessage,
    resolveApproval,
    resolveElicitation,
  } = usePraxisStore();

  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);

  const currentModel =
    models.find((m) => m.providerId === selectedProviderId && m.id === selectedModelId) ??
    models[0];

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToLatest(distanceFromBottom > 160);
  };

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  React.useEffect(() => {
    scrollToBottom('auto');
  }, [activeChat?.id, scrollToBottom]);

  const hasLiveStreamingContent =
    activeLiveRun &&
    (activeLiveRun.run.status === 'running' ||
      activeLiveRun.run.status === 'awaitingApproval' ||
      activeLiveRun.run.status === 'awaitingElicitation' ||
      activeLiveRun.run.status === 'failed');

  const isEmptyConversation = activeMessages.length === 0 && !hasLiveStreamingContent;

  return (
    <main
      data-testid="chat-screen"
      style={{
        position: 'relative',
        flex: 1,
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--paper-canvas)',
        overflow: 'hidden',
      }}
    >
      {/* Top Progressive Blur Scrim */}
      <ProgressiveBlurScrim
        edge="top"
        height={96}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 15,
        }}
      />

      <ChatHeader onOpenGlassLab={onOpenGlassLab} />

      {/* Main Scrollable Conversation Viewport */}
      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll-viewport"
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '88px 16px 190px',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 680,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Error Banner if present */}
          {(errorBanner || activeLiveRun?.run.error) && (
            <div
              role="alert"
              data-testid="chat-error-banner"
              style={{
                padding: '12px 16px',
                borderRadius: 14,
                background: 'var(--paper-surface)',
                border: '1px solid var(--paper-danger)',
                color: 'var(--paper-danger)',
                fontSize: 13.5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 18,
              }}
            >
              <span>{errorBanner || activeLiveRun?.run.error}</span>
              <button
                type="button"
                onClick={clearErrorBanner}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--paper-danger)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Editorial Empty State */}
          {isEmptyConversation ? (
            <div
              data-testid="chat-empty-state"
              style={{
                paddingTop: '14vh',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                gap: 20,
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 16,
                  background: 'var(--paper-fill-1)',
                  border: '0.5px solid var(--paper-hairline)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-serif)',
                  fontSize: 24,
                  fontWeight: 600,
                  color: 'var(--paper-ink)',
                }}
              >
                P
              </div>

              <div>
                <h1
                  style={{
                    margin: '0 0 8px',
                    fontFamily: 'var(--font-serif)',
                    fontSize: 28,
                    lineHeight: '34px',
                    fontWeight: 600,
                    letterSpacing: '-0.5px',
                    color: 'var(--paper-ink)',
                  }}
                >
                  What are we working on?
                </h1>
                <p
                  style={{
                    margin: 0,
                    fontSize: 15,
                    color: 'var(--paper-ink-2)',
                    maxWidth: 420,
                  }}
                >
                  Warm editorial workspace with live tools, MCP connectors, and liquid glass
                  surfaces.
                </p>
              </div>

              <div
                data-testid="starter-suggestions"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  gap: 8,
                  maxWidth: 560,
                  marginTop: 6,
                }}
              >
                {STARTER_SUGGESTIONS.map((item, idx) => (
                  <GlassChip
                    key={idx}
                    data-testid={`starter-chip-${idx}`}
                    onClick={() => void sendMessage(item.prompt, { script: item.script })}
                  >
                    {item.label}
                  </GlassChip>
                ))}
              </div>
            </div>
          ) : (
            /* Conversation Turns */
            activeMessages.map((msg) => {
              if (msg.role === 'assistant' && hasLiveStreamingContent && msg.runId === activeLiveRun?.run.id) return null;
              if (msg.role === 'user') {
                return (
                  <UserBubble
                    key={msg.id}
                    message={msg}
                    attachmentsById={attachmentsById}
                  />
                );
              }

              const msgToolSteps = extractMessageToolSteps(msg);
              const msgReasoning = msg.parts
                .filter((p) => p.type === 'reasoning')
                .map((p, i) => ({
                  id: `${msg.id}-r-${i}`,
                  text: p.text ?? '',
                  finished: true,
                }));
              const msgText = msg.parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('\n\n');

              return (
                <div key={msg.id} data-testid="assistant-turn">
                  {(msgToolSteps.length > 0 || msgReasoning.length > 0) && (
                    <MessageActivity message={msg} steps={msgToolSteps} liveRun={activeLiveRun?.run.id === msg.runId ? activeLiveRun?.run : undefined} liveSteps={activeLiveRun?.run.id === msg.runId ? activeLiveRun?.toolSteps : undefined} />
                  )}
                  {msgText && (
                    <AgentMessageView
                      text={msgText}
                      onRetry={() => {
                        const lastUser = [...activeMessages]
                          .reverse()
                          .find((m) => m.role === 'user');
                        const retryText = lastUser?.parts
                          .filter((p) => p.type === 'text')
                          .map((p) => p.text ?? '')
                          .join('\n');
                        if (retryText) {
                          void sendMessage(retryText);
                        }
                      }}
                    />
                  )}
                </div>
              );
            })
          )}

          {/* Active Live Run Streaming Block */}
          {hasLiveStreamingContent && activeLiveRun && (
            <div data-testid="live-run-streaming-turn">
              <AgentActivityView
                startedAt={activeLiveRun.run.createdAt}
                finishedAt={activeLiveRun.run.updatedAt}
                runId={activeLiveRun.run.id}
                isRunning={activeLiveRun.run.status === 'running'}
                reasoningBlocks={activeLiveRun.reasoningBlocks}
                toolSteps={activeLiveRun.toolSteps}
                pendingApprovals={activeLiveRun.pendingApprovals}
                pendingElicitations={activeLiveRun.pendingElicitations}
                visionActivities={activeLiveRun.visionActivities}
                compactions={activeLiveRun.compactions}
                onResolveApproval={(rId, aId, decision) =>
                  void resolveApproval(rId, aId, decision)
                }
                onResolveElicitation={(rId, eId, action, content) =>
                  void resolveElicitation(rId, eId, action, content)
                }
              />

              {activeLiveRun.textBlocks.length > 0 && (
                <AgentMessageView
                  text={activeLiveRun.textBlocks.map((b) => b.text).join('\n\n')}
                  isStreaming={activeLiveRun.run.status === 'running'}
                  usage={activeLiveRun.usage}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Progressive Blur Scrim */}
      <ProgressiveBlurScrim
        edge="bottom"
        height={148}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 15,
        }}
      />

      {/* Jump to Latest Floating Chip */}
      {showJumpToLatest && (
        <div
          style={{
            position: 'absolute',
            bottom: 102,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 25,
          }}
        >
          <GlassChip
            data-testid="jump-to-latest-button"
            onClick={() => scrollToBottom('smooth')}
          >
            Jump to latest ↓
          </GlassChip>
        </div>
      )}

      {/* Bottom Floating Composer Dock */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 20,
          padding: '0 14px 16px',
          pointerEvents: 'none',
        }}
      >
        <Composer />
      </div>
    </main>
  );
};
