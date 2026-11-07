import React from 'react';
import styles from './InlineTokens.module.css';
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
            className={styles.token}
          >
            <span aria-hidden="true" className={styles.token}>
              <FileText size={16} />
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
            className={styles.token}
          >
            <span className={styles.token}>{label}</span>
            <span className={styles.token}>{domain} ↗</span>
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
          className={styles.token}
        >
          {isFileRef && (
            <span aria-hidden="true" className={styles.token}>
              <FileText size={16} />
            </span>
          )}
          <span>{codeContent}</span>
        </button>,
      );
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={`bold-${keyIdx++}`}>{match[5]}</strong>);
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
