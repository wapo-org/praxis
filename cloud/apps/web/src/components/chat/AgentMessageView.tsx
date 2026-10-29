import React from 'react';
import type { Usage } from '@praxis/protocol';

export interface AgentMessageViewProps {
  text: string;
  isStreaming?: boolean;
  usage?: Usage;
  onRetry?: () => void;
}

interface ParsedBlock {
  type: 'heading' | 'code' | 'table' | 'blockquote' | 'list' | 'hr' | 'paragraph';
  level?: number;
  lang?: string;
  content?: string;
  headers?: string[];
  rows?: string[][];
  ordered?: boolean;
  items?: Array<{ checked?: boolean; text: string }>;
}

function parseMarkdownBlocks(markdown: string): ParsedBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.startsWith('```')) {
        i++;
      }
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length,
        content: headingMatch[2]!.trim(),
      });
      i++;
      continue;
    }

    // GFM Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1]!)
    ) {
      const parseRow = (rowStr: string) =>
        rowStr
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const headers = parseRow(line);
      i += 2; // skip header and separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Unordered or task list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ checked?: boolean; text: string }> = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        const raw = lines[i]!.replace(/^\s*[-*+]\s+/, '');
        const taskMatch = raw.match(/^\[([ xX])\]\s+(.+)$/);
        if (taskMatch) {
          items.push({
            checked: taskMatch[1]!.toLowerCase() === 'x',
            text: taskMatch[2]!,
          });
        } else {
          items.push({ text: raw });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: Array<{ checked?: boolean; text: string }> = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const raw = lines[i]!.replace(/^\s*\d+\.\s+/, '');
        items.push({ text: raw });
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('>')
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
  }

  return blocks;
}

const FILE_PATH_PATTERN =
  /^(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+(?:#L\d+(?:-L?\d+)?|:\d+)?$|^[\w.-]+\.(?:swift|ts|tsx|js|json|md|py|rs|go|css|html)(?:#L\d+|:\d+)?$/;

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

  const renderInlineTokens = (str: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    // Match markdown links [text](url), inline code `code`, bold **bold**, italic *italic*
    const tokenRegex = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyIdx = 0;

    while ((match = tokenRegex.exec(str)) !== null) {
      if (match.index > lastIndex) {
        nodes.push(str.slice(lastIndex, match.index));
      }

      if (match[2] !== undefined && match[3] !== undefined) {
        const label = match[2];
        const url = match[3];
        let domain = '';
        try {
          domain = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          domain = url;
        }
        // LinkRef chip or FileRef if file://
        if (url.startsWith('file://') || FILE_PATH_PATTERN.test(label)) {
          nodes.push(
            <button
              key={`file-${keyIdx++}`}
              type="button"
              data-testid="inline-file-chip"
              onClick={() =>
                setInspectedChip({
                  kind: 'file',
                  label,
                  detail: url,
                })
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '1px 8px',
                margin: '0 2px',
                borderRadius: 7,
                background: 'var(--paper-fill-1)',
                border: '0.5px solid var(--paper-hairline)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13.5,
                lineHeight: '20px',
                color: 'var(--paper-ink)',
                cursor: 'pointer',
                verticalAlign: 'baseline',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--paper-accent)' }}>
                📄
              </span>
              <span>{label}</span>
            </button>,
          );
        } else {
          nodes.push(
            <a
              key={`link-${keyIdx++}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              data-testid="inline-link-chip"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '1px 9px',
                margin: '0 2px',
                borderRadius: 999,
                background: 'var(--paper-fill-1)',
                border: '0.5px solid var(--paper-hairline)',
                fontSize: 14,
                lineHeight: '20px',
                color: 'var(--paper-ink)',
                textDecoration: 'none',
                verticalAlign: 'baseline',
              }}
            >
              <span style={{ fontWeight: 500 }}>{label}</span>
              <span style={{ fontSize: 11.5, color: 'var(--paper-ink-3)' }}>{domain} ↗</span>
            </a>,
          );
        }
      } else if (match[4] !== undefined) {
        const codeContent = match[4];
        const isFileRef = FILE_PATH_PATTERN.test(codeContent);
        nodes.push(
          <button
            key={`code-${keyIdx++}`}
            type="button"
            data-testid={isFileRef ? 'inline-file-chip' : 'inline-code-pill'}
            onClick={() =>
              setInspectedChip({
                kind: isFileRef ? 'file' : 'code',
                label: codeContent,
                detail: isFileRef
                  ? `Workspace file reference: ${codeContent}`
                  : `Symbol / code snippet: ${codeContent}`,
              })
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 7px',
              margin: '0 1.5px',
              borderRadius: 6,
              background: 'var(--paper-fill-1)',
              border: '0.5px solid var(--paper-hairline)',
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              lineHeight: '20px',
              color: 'var(--paper-ink)',
              cursor: 'pointer',
              verticalAlign: 'baseline',
            }}
          >
            {isFileRef && (
              <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--paper-accent)' }}>
                📄
              </span>
            )}
            <span>{codeContent}</span>
          </button>,
        );
      } else if (match[5] !== undefined) {
        nodes.push(
          <strong key={`bold-${keyIdx++}`} style={{ fontWeight: 600 }}>
            {match[5]}
          </strong>,
        );
      } else if (match[6] !== undefined) {
        nodes.push(<em key={`em-${keyIdx++}`}>{match[6]}</em>);
      }

      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < str.length) {
      nodes.push(str.slice(lastIndex));
    }

    return nodes;
  };

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
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const isH1 = block.level === 1;
            const isH2 = block.level === 2;
            return (
              <div
                key={idx}
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: isH1 ? 26 : isH2 ? 21 : 18,
                  lineHeight: isH1 ? '32px' : isH2 ? '27px' : '24px',
                  fontWeight: 600,
                  letterSpacing: isH1 ? '-0.4px' : '-0.3px',
                  marginTop: idx === 0 ? 0 : 8,
                  color: 'var(--paper-ink)',
                }}
              >
                {renderInlineTokens(block.content ?? '')}
              </div>
            );
          }

          case 'code': {
            return (
              <div
                key={idx}
                data-testid="markdown-code-block"
                style={{
                  borderRadius: 14,
                  background: 'var(--paper-surface-2)',
                  border: '0.5px solid var(--paper-hairline)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 14px',
                    background: 'var(--paper-fill-1)',
                    borderBottom: '0.5px solid var(--paper-hairline)',
                    fontSize: 12,
                    color: 'var(--paper-ink-2)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span>{block.lang || 'code'}</span>
                  <button
                    type="button"
                    data-testid="code-copy-button"
                    onClick={() => handleCopyCode(idx, block.content ?? '')}
                    style={{
                      border: '0.5px solid var(--paper-hairline)',
                      background: 'var(--paper-surface)',
                      borderRadius: 7,
                      padding: '2px 9px',
                      fontSize: 11.5,
                      color: 'var(--paper-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedCodeIdx === idx ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '13px 16px',
                    overflowX: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    lineHeight: '20px',
                    color: 'var(--paper-ink)',
                  }}
                >
                  <code>{block.content}</code>
                </pre>
              </div>
            );
          }

          case 'table': {
            return (
              <div
                key={idx}
                data-testid="markdown-table-card"
                style={{
                  borderRadius: 12,
                  background: 'var(--paper-surface)',
                  border: '0.5px solid var(--paper-hairline)',
                  overflowX: 'auto',
                  boxShadow: '0 2px 10px rgba(18, 17, 15, 0.03)',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 14,
                    lineHeight: '20px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <thead>
                    <tr style={{ background: 'var(--paper-fill-1)' }}>
                      {(block.headers ?? []).map((h, hIdx) => (
                        <th
                          key={hIdx}
                          style={{
                            textAlign: 'left',
                            padding: '10px 14px',
                            fontWeight: 600,
                            borderBottom: '0.5px solid var(--paper-hairline)',
                            color: 'var(--paper-ink)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {renderInlineTokens(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        style={{
                          borderBottom:
                            rIdx < (block.rows?.length ?? 0) - 1
                              ? '0.5px solid var(--paper-hairline)'
                              : 'none',
                        }}
                      >
                        {row.map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            style={{
                              padding: '9px 14px',
                              color: 'var(--paper-ink-2)',
                              verticalAlign: 'top',
                            }}
                          >
                            {renderInlineTokens(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          case 'blockquote':
            return (
              <blockquote
                key={idx}
                style={{
                  margin: 0,
                  padding: '4px 0 4px 16px',
                  borderLeft: '2px solid var(--paper-rule-strong)',
                  color: 'var(--paper-ink-2)',
                  fontStyle: 'italic',
                }}
              >
                {renderInlineTokens(block.content ?? '')}
              </blockquote>
            );

          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag
                key={idx}
                style={{
                  margin: 0,
                  paddingLeft: 22,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {(block.items ?? []).map((item, itemIdx) => (
                  <li
                    key={itemIdx}
                    style={{
                      listStyleType: item.checked !== undefined ? 'none' : undefined,
                      marginLeft: item.checked !== undefined ? -18 : 0,
                    }}
                  >
                    {item.checked !== undefined && (
                      <input
                        type="checkbox"
                        checked={item.checked}
                        readOnly
                        style={{ marginRight: 8, accentColor: 'var(--paper-accent)' }}
                      />
                    )}
                    {renderInlineTokens(item.text)}
                  </li>
                ))}
              </ListTag>
            );
          }

          case 'hr':
            return (
              <hr
                key={idx}
                style={{
                  border: 'none',
                  borderTop: '0.5px solid var(--paper-hairline)',
                  margin: '6px 0',
                }}
              />
            );

          case 'paragraph':
          default:
            return (
              <p key={idx} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {renderInlineTokens(block.content ?? '')}
              </p>
            );
        }
      })}

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
            <div style={{ fontSize: 12, color: 'var(--paper-ink-2)' }}>
              {inspectedChip.detail}
            </div>
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
            <span>{copiedTurn ? '✓ Copied' : '⧉ Copy'}</span>
          </button>

          {onRetry && (
            <button
              type="button"
              data-testid="turn-retry-button"
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
              <span>↻ Retry</span>
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
