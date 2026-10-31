import React from 'react';
import type { ParsedBlock } from './markdownBlocks';
export function MarkdownContent({
  blocks,
  renderInlineTokens,
  copiedCodeIdx,
  handleCopyCode,
}: {
  blocks: ParsedBlock[];
  renderInlineTokens: (value: string) => React.ReactNode;
  copiedCodeIdx: number | null;
  handleCopyCode: (index: number, text: string) => void;
}) {
  return (
    <>
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
                        style={{
                          marginRight: 8,
                          accentColor: 'var(--paper-accent)',
                        }}
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
    </>
  );
}
