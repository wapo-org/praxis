import type { Attachment, MessagePart } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { FileText, Paperclip } from '../../lib/icons';
import { safeLink } from '../../lib/links';
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
        onClick={() => onPreview(url)}
        style={{
          padding: 0,
          border: '1px solid var(--paper-hairline)',
          borderRadius: 14,
          overflow: 'hidden',
          background: 'var(--paper-fill-1)',
        }}
      >
        <img
          src={url}
          alt={att?.name || 'Attached image'}
          style={{
            maxWidth: 180,
            maxHeight: 160,
            display: 'block',
            objectFit: 'cover',
          }}
        />
      </button>
    );
  return (
    <div
      data-testid="document-attachment-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '9px 12px',
        borderRadius: 12,
        background: 'var(--paper-fill-1)',
        border: '1px solid var(--paper-hairline)',
        color: 'var(--paper-ink)',
        fontSize: 13,
      }}
    >
      {part.type === 'document' ? <FileText size={17} /> : <Paperclip size={17} />}
      <span>
        {unavailable
          ? 'Attachment unavailable'
          : (att?.name ?? (part.type === 'document' ? 'Document' : 'Attachment'))}
      </span>
    </div>
  );
}
