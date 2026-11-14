import type { Usage } from '@praxis/protocol';
import React from 'react';
import { Check, Copy, Retry } from '../../lib/icons';

export interface AgentMessageViewProps {
  text: string;
  isStreaming?: boolean;
  usage?: Usage;
  onRetry?: () => void;
  children?: React.ReactNode;
}

import { MarkdownContent } from './MarkdownContent';
import styles from './AgentMessageView.module.css';
export const AgentMessageView: React.FC<AgentMessageViewProps> = ({
  text,
  isStreaming = false,
  usage,
  onRetry,
  children,
}) => {
  const [copiedTurn, setCopiedTurn] = React.useState(false);
  const handleCopyTurn = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedTurn(true);
    setTimeout(() => setCopiedTurn(false), 1600);
  };

  return (
    <div data-testid="agent-message-view" className={styles.message} data-revealed={text}>
      {children ?? <MarkdownContent text={text} isStreaming={isStreaming} />}

      {!isStreaming && text.trim().length > 0 ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            data-testid="turn-copy-button"
            aria-label={copiedTurn ? 'Copied' : 'Copy message'}
            title="Copy"
            onClick={handleCopyTurn}
          >
            {copiedTurn ? <Check size={16} /> : <Copy size={16} />}
          </button>
          {onRetry ? (
            <button
              type="button"
              className={styles.action}
              data-testid="turn-retry-button"
              aria-label="Retry response"
              title="Retry"
              onClick={onRetry}
            >
              <Retry size={16} />
            </button>
          ) : null}
          {usage && (usage.inputTokens || usage.outputTokens) ? (
            <span className={styles.usage}>
              {usage.inputTokens ?? 0} in · {usage.outputTokens ?? 0} out
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
