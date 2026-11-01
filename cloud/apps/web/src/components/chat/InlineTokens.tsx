import React from 'react';
import { FileText } from '../../lib/icons';
import { safeLink } from '../../lib/links';

export interface ChipInspection {
  kind: 'file' | 'link' | 'code';
  label: string;
  detail: string;
}
const FILE_PATH_PATTERN =
  /^(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+(?:#L\d+(?:-L?\d+)?|:\d+)?$|^[\w.-]+\.(?:swift|ts|tsx|js|json|md|py|rs|go|css|html)(?:#L\d+|:\d+)?$/;

export function renderInlineTokens(
  str: string,
  setInspectedChip: (value: ChipInspection) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match markdown links [text](url), inline code `code`, bold **bold**, italic *italic*
  const tokenRegex = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~)/g;
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
              whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--paper-accent)' }}>
              <FileText size={13} />
            </span>
            <span>{label}</span>
          </button>,
        );
      } else if (safeLink(url)) {
        nodes.push(
          <a
            key={`link-${keyIdx++}`}
            href={safeLink(url)}
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
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontWeight: 500 }}>{label}</span>
            <span style={{ fontSize: 11.5, color: 'var(--paper-ink-3)' }}>{domain} ↗</span>
          </a>,
        );
      } else {
        nodes.push(label);
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
            whiteSpace: 'nowrap',
          }}
        >
          {isFileRef && (
            <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--paper-accent)' }}>
              <FileText size={13} />
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
    } else if (match[7] !== undefined) {
      nodes.push(<del key={`del-${keyIdx++}`}>{match[7]}</del>);
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < str.length) {
    nodes.push(str.slice(lastIndex));
  }

  return nodes;
}
