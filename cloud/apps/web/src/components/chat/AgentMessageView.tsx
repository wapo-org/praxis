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
import { MarkdownContent } from './MarkdownContent';
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

  const blocks = React.useMemo(() => parseMarkdownBlocks(text), [text]);

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
    <div
      data-testid="agent-message-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        color: 'var(--paper-ink)',
        fontSize: 17,
        lineHeight: '27px',
        letterSpacing: '-0.2px',
        marginBottom: 22,
      }}
    >
      <MarkdownContent
        blocks={blocks}
        renderInlineTokens={renderInlineTokens}
        copiedCodeIdx={copiedCodeIdx}
        handleCopyCode={handleCopyCode}
      />

      {/* Inline Chip Inspector Popover */}
      {inspectedChip && (
        <div
          data-testid="chip-inspector-card"
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 13,
            boxShadow: '0 6px 20px rgba(18, 17, 15, 0.06)',
          }}
        >
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {inspectedChip.label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--paper-ink-2)' }}>{inspectedChip.detail}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                  void navigator.clipboard.writeText(inspectedChip.label);
                }
                setInspectedChip(null);
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 8,
                border: '0.5px solid var(--paper-hairline)',
                background: 'var(--paper-fill-1)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setInspectedChip(null)}
              style={{
                padding: '4px 8px',
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--paper-ink-3)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Turn Footer Actions */}
      {!isStreaming && text.trim().length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: -4,
            color: 'var(--paper-ink-3)',
            fontSize: 12,
          }}
        >
          <button
            type="button"
            data-testid="turn-copy-button"
            aria-label={copiedTurn ? 'Copied' : 'Copy message'}
            onClick={handleCopyTurn}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              color: 'var(--paper-ink-3)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {copiedTurn ? <Check size={16} /> : <Copy size={16} />}
          </button>

          {onRetry && (
            <button
              type="button"
              data-testid="turn-retry-button"
              aria-label="Retry response"
              onClick={onRetry}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 7,
                border: 'none',
                background: 'transparent',
                color: 'var(--paper-ink-3)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <Retry size={16} />
            </button>
          )}

          {usage && (usage.inputTokens || usage.outputTokens) && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {usage.inputTokens ?? 0} in · {usage.outputTokens ?? 0} out
            </span>
          )}
        </div>
      )}
    </div>
  );
};
