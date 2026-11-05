import type { Attachment, MessagePart } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { FileText, Paperclip } from '../../lib/icons';
import { safeLink } from '../../lib/links';
import styles from './MessageAttachment.module.css';
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
  const image = part.type === 'image' && url && /^https?:/.test(url);
  if (image)
    return (
      <button
        type="button"
        className={styles.image}
        onClick={() => onPreview(url)}
      >
        <img
          src={url}
          alt={att?.name || 'Attached image'}
        />
      </button>
    );
  return (
    <div
      className={styles.document}
      data-testid="document-attachment-chip"
    >
      {part.type === 'document' ? <FileText size={18} /> : <Paperclip size={18} />}
      <span>
        {unavailable
          ? 'Attachment unavailable'
          : (att?.name ?? (part.type === 'document' ? 'Document' : 'Attachment'))}
      </span>
    </div>
  );
}
