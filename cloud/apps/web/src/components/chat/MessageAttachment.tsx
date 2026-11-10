import type { Attachment, MessagePart } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { safeLink } from '../../lib/links';
import { AttachmentChip, AttachmentThumb } from './AttachmentChip';

/** One attachment on a sent message: images as thumbnails, everything else as a file chip. */
export function MessageAttachment({
  part,
  attachment,
  onPreview,
}: {
  part: MessagePart;
  attachment?: Attachment;
  onPreview: (url: string) => void;
}) {
  const [loaded, setLoaded] = React.useState(attachment);
  const [unavailable, setUnavailable] = React.useState(false);
  React.useEffect(() => {
    if (attachment) {
      setLoaded(attachment);
      return;
    }
    if (!part.attachmentId) return;
    let active = true;
    void apiClient
      .getAttachment(part.attachmentId)
      .then((value) => {
        if (active) setLoaded(value);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [attachment, part.attachmentId]);
  const att = attachment ?? loaded;
  const url = safeLink(att?.url);
  const mediaType = att?.mediaType ?? part.mediaType ?? 'application/octet-stream';
  if (part.type === 'image' && url && /^https?:/.test(url))
    return <AttachmentThumb src={url} name={att?.name || 'Attached image'} onOpen={() => onPreview(url)} />;
  const name = unavailable ? 'Attachment unavailable' : (att?.name ?? (part.type === 'image' ? 'Image' : 'File'));
  return (
    <AttachmentChip
      testId="document-attachment-chip"
      name={name}
      mediaType={mediaType}
      size={att?.size}
      status={att ? undefined : unavailable ? 'Removed or not accessible' : 'Loading…'}
    />
  );
}
