import type { Attachment, Message } from '@praxis/protocol';
import React from 'react';
import { bindSendFlightTarget, isSendFlightTarget } from './chatMotion';
import { MessageAttachment } from './MessageAttachment';
import styles from './UserBubble.module.css';

export interface UserBubbleProps {
  message: Message;
  attachmentsById: Record<string, Attachment>;
}

export const UserBubble: React.FC<UserBubbleProps> = ({ message, attachmentsById }) => {
  const [lightboxUrl, setLightboxUrl] = React.useState<string | null>(null);

  const textParts = message.parts.filter((p) => p.type === 'text');
  const mediaParts = message.parts.filter((p) => p.type === 'image' || p.type === 'document');

  const combinedText = textParts.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n');
  const turnKey = message.clientTurnId ?? message.id;

  const bubbleRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) bindSendFlightTarget(el, turnKey, combinedText);
    },
    [turnKey, combinedText],
  );

  if (!combinedText && mediaParts.length === 0) return null;

  return (
    <>
      <div data-testid="user-message-bubble" data-message-key={`m:${turnKey}`} className={styles.turn}>
        {mediaParts.length > 0 ? (
          <div className={styles.media} data-with-text={!!combinedText}>
            {mediaParts.map((part, index) => (
              <MessageAttachment
                key={`${part.attachmentId}-${index}`}
                part={part}
                attachment={part.attachmentId ? attachmentsById[part.attachmentId] : undefined}
                onPreview={setLightboxUrl}
              />
            ))}
          </div>
        ) : null}
        {combinedText ? (
          <div ref={bubbleRef} data-user-bubble="" className={styles.bubble} style={isSendFlightTarget(turnKey,combinedText)?{visibility:'hidden',opacity:0}:undefined}>
            {combinedText}
          </div>
        ) : null}
      </div>

      {lightboxUrl ? (
        <div role="dialog" aria-label="Image preview" className={styles.lightbox} onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Full size attachment" />
        </div>
      ) : null}
    </>
  );
};
