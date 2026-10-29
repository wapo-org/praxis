import React from 'react';
import type { Attachment, Message } from '@praxis/protocol';

export interface UserBubbleProps {
  message: Message;
  attachmentsById: Record<string, Attachment>;
}

export const UserBubble: React.FC<UserBubbleProps> = ({ message, attachmentsById }) => {
  const [lightboxUrl, setLightboxUrl] = React.useState<string | null>(null);

  const textParts = message.parts.filter((p) => p.type === 'text');
  const mediaParts = message.parts.filter(
    (p) => p.type === 'image' || p.type === 'document',
  );

  const combinedText = textParts.map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('\n');

  return (
    <>
      <div
        data-testid="user-message-bubble"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          marginBottom: 18,
          animation: 'praxisBubbleIn 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        }}
      >
        {mediaParts.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              justifyContent: 'flex-end',
              marginBottom: combinedText ? 8 : 0,
              maxWidth: '78%',
            }}
          >
            {mediaParts.map((part, idx) => {
              const attId =
                (part.type === 'image' || part.type === 'document'
                  ? part.attachmentId
                  : '') ?? '';
              const att = attId ? attachmentsById[attId] : undefined;
              const isImage =
                part.type === 'image' || (att?.mediaType?.startsWith('image/') ?? false);

              if (isImage && att?.url) {
                return (
                  <button
                    key={`${attId}-${idx}`}
                    type="button"
                    onClick={() => setLightboxUrl(att.url ?? null)}
                    style={{
                      padding: 0,
                      border: '0.5px solid var(--paper-hairline)',
                      borderRadius: 14,
                      overflow: 'hidden',
                      cursor: 'zoom-in',
                      background: 'var(--paper-fill-1)',
                      width: 136,
                      height: 102,
                    }}
                  >
                    <img
                      src={att.url}
                      alt={att.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </button>
                );
              }

              return (
                <div
                  key={`${attId}-${idx}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 12,
                    background: 'var(--paper-fill-1)',
                    border: '0.5px solid var(--paper-hairline)',
                    fontSize: 13,
                    color: 'var(--paper-ink)',
                  }}
                >
                  <span aria-hidden="true">📎</span>
                  <span>{att?.name ?? `Attachment (${attId.slice(0, 8)})`}</span>
                </div>
              );
            })}
          </div>
        )}

        {combinedText && (
          <div
            style={{
              maxWidth: '78%',
              padding: '12px 16px',
              borderRadius: '20px 20px 8px 20px',
              background: 'var(--paper-fill-1)',
              border: '0.5px solid var(--paper-hairline)',
              color: 'var(--paper-ink)',
              fontSize: 17,
              lineHeight: '24px',
              letterSpacing: '-0.25px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              boxShadow: '0 2px 8px rgba(18, 17, 15, 0.03)',
            }}
          >
            {combinedText}
          </div>
        )}
      </div>

      {lightboxUrl && (
        <div
          role="dialog"
          aria-label="Image preview"
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 250,
            background: 'rgba(12, 12, 11, 0.78)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={lightboxUrl}
            alt="Full size attachment"
            style={{
              maxWidth: '92vw',
              maxHeight: '88vh',
              borderRadius: 16,
              boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
            }}
          />
        </div>
      )}
    </>
  );
};
