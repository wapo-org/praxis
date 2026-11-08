import type { Usage } from '@praxis/protocol';
import React from 'react';
import { Check, Copy, Retry } from '../../lib/icons';

export interface AgentMessageViewProps {
  text: string;
  isStreaming?: boolean;
  usage?: Usage;
  onRetry?: () => void;
}

import { renderInlineTokens as inlineTokens } from './InlineTokens';
import { parseMarkdownBlocks } from './markdownBlocks';
import { stableStreamingMarkdown } from './streamingMarkdown';
import { usePacedText } from './usePacedText';
import { MarkdownContent } from './MarkdownContent';
import styles from './AgentMessageView.module.css';
export const AgentMessageView: React.FC<AgentMessageViewProps> = ({
  text,
  isStreaming = false,
  usage,
  onRetry,
}) => {
  const [copiedTurn, setCopiedTurn] = React.useState(false);
  const [copiedCodeIdx, setCopiedCodeIdx] = React.useState<number | null>(null);
  const [inspectedChip, setInspectedChip] = React.useState<{
    kind: 'file' | 'code' | 'link';
    label: string;
    detail?: string;
  } | null>(null);

  const revealed = usePacedText(text, isStreaming);
  const blocks = React.useMemo(() => parseMarkdownBlocks(isStreaming ? stableStreamingMarkdown(revealed) : revealed), [revealed, isStreaming]);

  const renderInlineTokens = (value: string) => inlineTokens(value, setInspectedChip);

  const handleCopyTurn = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedTurn(true);
    setTimeout(() => setCopiedTurn(false), 1600);
  };

  const handleCopyCode = (idx: number, code: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(code);
    }
    setCopiedCodeIdx(idx);
    setTimeout(() => setCopiedCodeIdx((curr) => (curr === idx ? null : curr)), 1600);
  };

  return (
    <div data-testid="agent-message-view" className={styles.message} data-revealed={revealed}>
      <MarkdownContent
        blocks={blocks}
        renderInlineTokens={renderInlineTokens}
        copiedCodeIdx={copiedCodeIdx}
        handleCopyCode={handleCopyCode}
      />

      {inspectedChip ? (
        <div data-testid="chip-inspector-card" className={styles.inspector}>
          <div className={styles.inspectorCopy}>
            <span className={styles.inspectorLabel}>{inspectedChip.label}</span>
            <span className={styles.inspectorDetail}>{inspectedChip.detail}</span>
          </div>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(inspectedChip.label);
              }
              setInspectedChip(null);
            }}
          >
            Copy
          </button>
          <button type="button" className={styles.textButton} onClick={() => setInspectedChip(null)}>
            Close
          </button>
        </div>
      ) : null}

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
