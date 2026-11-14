import { bindIcon } from '@praxis/glass';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageGlyph,
  X as XGlyph,
} from 'lucide-react';
import React from 'react';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  type AttachmentOrientation,
  type AttachmentSize,
  type AttachmentState,
} from '../ui/attachment';
import { attachmentKind, formatBytes, type AttachmentKind } from './attachmentInfo';

const ICONS: Record<AttachmentKind, ReturnType<typeof bindIcon>> = {
  image: bindIcon(ImageGlyph),
  pdf: bindIcon(FileText),
  archive: bindIcon(FileArchive),
  sheet: bindIcon(FileSpreadsheet),
  code: bindIcon(FileCode),
  text: bindIcon(FileText),
  audio: bindIcon(FileAudio),
  video: bindIcon(FileVideo),
  file: bindIcon(File),
};
const Remove = bindIcon(XGlyph);
const KIND_LABEL: Record<AttachmentKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  archive: 'Archive',
  sheet: 'Spreadsheet',
  code: 'Code',
  text: 'Text',
  audio: 'Audio',
  video: 'Video',
  file: 'File',
};

/**
 * A file attachment card backed by components/ui/attachment: shows a type icon or image preview,
 * file title (shimmering while uploading/processing), metadata or limit/error status, optional open trigger,
 * and optional remove action.
 */
export function AttachmentChip({
  name,
  mediaType,
  size,
  status,
  note,
  noteLevel,
  previewUrl,
  href,
  onOpen,
  onRemove,
  state,
  cardSize = 'default',
  orientation = 'horizontal',
  testId = 'attachment-chip',
}: {
  name: string;
  mediaType: string;
  size?: number;
  status?: string;
  note?: string;
  noteLevel?: 'warn' | 'block';
  previewUrl?: string;
  href?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  state?: AttachmentState;
  cardSize?: AttachmentSize;
  orientation?: AttachmentOrientation;
  testId?: string;
}) {
  const kind = attachmentKind(name, mediaType);
  const Icon = ICONS[kind];
  const meta = status ?? [KIND_LABEL[kind], size !== undefined ? formatBytes(size) : ''].filter(Boolean).join(' · ');
  const resolvedState: AttachmentState =
    state ??
    (noteLevel === 'block' || status === 'Removed or not accessible'
      ? 'error'
      : status
        ? 'uploading'
        : 'done');

  return (
    <Attachment
      state={resolvedState}
      size={cardSize}
      orientation={orientation}
      data-testid={testId}
      data-kind={kind}
      data-level={status ? undefined : noteLevel}
      data-busy={status ? 'true' : undefined}
    >
      {href ? (
        <AttachmentTrigger
          render={<a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name}`} />}
        />
      ) : onOpen ? (
        <AttachmentTrigger aria-label={`Open ${name}`} onClick={onOpen} />
      ) : null}
      <AttachmentMedia variant={previewUrl && kind === 'image' ? 'image' : 'icon'} aria-hidden={!(previewUrl && kind === 'image')}>
        {previewUrl && kind === 'image' ? <img src={previewUrl} alt={name} /> : <Icon size={18} />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={name}>{name}</AttachmentTitle>
        <AttachmentDescription role={note || status ? 'status' : undefined}>
          {status ?? note ?? meta}
        </AttachmentDescription>
      </AttachmentContent>
      {onRemove ? (
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${name}`} onClick={onRemove}>
            <Remove size={16} />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

/** Vertical image preview card used in sent messages; clicking opens the lightbox preview. */
export function AttachmentThumb({
  src,
  name,
  meta,
  onOpen,
}: {
  src: string;
  name: string;
  meta?: string;
  onOpen?: () => void;
}) {
  return (
    <Attachment orientation="vertical" state="done" data-kind="image">
      <AttachmentTrigger onClick={onOpen} data-testid="attachment-thumb" aria-label={`Open ${name}`} />
      <AttachmentMedia variant="image">
        <img src={src} alt={name} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={name}>{name}</AttachmentTitle>
        <AttachmentDescription>{meta || 'Image'}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}
