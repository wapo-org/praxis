import { bindIcon } from '@praxis/glass';
import { File, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, FileVideo, Image as ImageGlyph, X as XGlyph } from 'lucide-react';
import React from 'react';
import { attachmentKind, formatBytes, type AttachmentKind } from './attachmentInfo';
import styles from './AttachmentChip.module.css';

const ICONS: Record<AttachmentKind, ReturnType<typeof bindIcon>> = {
  image: bindIcon(ImageGlyph), pdf: bindIcon(FileText), archive: bindIcon(FileArchive), sheet: bindIcon(FileSpreadsheet),
  code: bindIcon(FileCode), text: bindIcon(FileText), audio: bindIcon(FileAudio), video: bindIcon(FileVideo), file: bindIcon(File),
};
const Remove = bindIcon(XGlyph);
const KIND_LABEL: Record<AttachmentKind, string> = {
  image: 'Image', pdf: 'PDF', archive: 'Archive', sheet: 'Spreadsheet', code: 'Code', text: 'Text', audio: 'Audio', video: 'Video', file: 'File',
};

/**
 * A file as a file: a type icon in a tile, the name, then its type and size. In the composer it can be removed,
 * shows its upload, and states a size limit in plain words; in a sent message it sits on the bubble.
 */
export function AttachmentChip({
  name,
  mediaType,
  size,
  status,
  note,
  noteLevel,
  onRemove,
  testId = 'attachment-chip',
}: {
  name: string;
  mediaType: string;
  size?: number;
  status?: string;
  note?: string;
  noteLevel?: 'warn' | 'block';
  onRemove?: () => void;
  testId?: string;
}) {
  const kind = attachmentKind(name, mediaType);
  const Icon = ICONS[kind];
  const meta = status ?? [KIND_LABEL[kind], size !== undefined ? formatBytes(size) : ''].filter(Boolean).join(' · ');
  return (
    <div className={styles.chip} data-testid={testId} data-kind={kind} data-level={noteLevel}>
      <span className={styles.tile} aria-hidden="true"><Icon size={18} /></span>
      <span className={styles.copy}>
        <span className={styles.name} title={name}>{name}</span>
        <span className={styles.meta} role={note ? 'status' : undefined}>{note ?? meta}</span>
      </span>
      {onRemove ? (
        <button type="button" className={styles.remove} aria-label={`Remove ${name}`} onClick={onRemove}>
          <Remove size={16} />
        </button>
      ) : null}
    </div>
  );
}

export function AttachmentThumb({ src, name, onOpen }: { src: string; name: string; onOpen?: () => void }) {
  return (
    <button type="button" className={styles.thumb} onClick={onOpen} data-testid="attachment-thumb" aria-label={`Open ${name}`}>
      <img src={src} alt={name} />
    </button>
  );
}
