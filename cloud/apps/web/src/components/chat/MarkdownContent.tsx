import React from 'react';
import type { ParsedBlock } from './markdownBlocks';
import styles from './MarkdownContent.module.css';

/** Editorial rendering of parsed assistant markdown. Typography comes from tokens. */
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
          case 'heading':
            return React.createElement(
              `h${block.level ?? 3}`,
              {
                key: idx,
                className: styles.heading,
                'data-level': block.level ?? 3,
              },
              renderInlineTokens(block.content ?? ''),
            );

          case 'code':
            return (
              <div key={idx} data-testid="markdown-code-block" className={styles.code}>
                <div className={styles.codeHeader}>
                  <span>{block.lang || 'code'}</span>
                  <button
                    type="button"
                    data-testid="code-copy-button"
                    onClick={() => handleCopyCode(idx, block.content ?? '')}
                  >
                    {copiedCodeIdx === idx ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre>
                  <code>{block.content}</code>
                </pre>
              </div>
            );

          case 'table':
            return (
              <div key={idx} data-testid="markdown-table-card" className={styles.table}>
                <table>
                  <thead>
                    <tr>
                      {(block.headers ?? []).map((h, hIdx) => (
                        <th key={hIdx} data-align={block.alignments?.[hIdx]}>
                          {renderInlineTokens(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <td key={cIdx} data-align={block.alignments?.[cIdx]}>
                            {renderInlineTokens(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case 'blockquote':
            return (
              <blockquote key={idx} className={styles.quote}>
                {renderInlineTokens(block.content ?? '')}
              </blockquote>
            );

          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag
                key={idx}
                className={styles.list}
                start={block.ordered ? block.start : undefined}
              >
                {(block.items ?? []).map((item, itemIdx) => (
                  <li key={itemIdx} data-task={item.checked !== undefined}>
                    {item.checked !== undefined ? (
                      <input type="checkbox" checked={item.checked} readOnly />
                    ) : null}
                    {renderInlineTokens(item.text)}
                  </li>
                ))}
              </ListTag>
            );
          }

          case 'hr':
            return <hr key={idx} className={styles.rule} />;

          case 'paragraph':
          default:
            return (
              <p key={idx} className={styles.paragraph}>
                {renderInlineTokens(block.content ?? '')}
              </p>
            );
        }
      })}
    </>
  );
}
