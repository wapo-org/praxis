import type { Attachment, Message } from '@praxis/protocol';
import React from 'react';
import { Copy, Check } from '../../lib/icons';
import { AttachmentGroup } from '../ui/attachment';
import actionStyles from './AgentMessageView.module.css';
import { bindSendFlightTarget, isSendFlightTarget } from './chatMotion';
import { MessageAttachment } from './MessageAttachment';
import styles from './UserBubble.module.css';

export interface UserBubbleProps {
  message: Message;
  attachmentsById: Record<string, Attachment>;
}

export const UserBubble: React.FC<UserBubbleProps> = ({ message, attachmentsById }) => {
  const [copied, setCopied] = React.useState(false);
  const [lightboxUrl, setLightboxUrl] = React.useState<string | null>(null);

  const textParts = message.parts.filter((p) => p.type === 'text');
  const mediaParts = message.parts.filter((p) => !!p.attachmentId && (p.type === 'image' || p.type === 'document' || p.type === 'note'));

  const joined = textParts.map((p) => p.text ?? '').join('\n');
  // The composer sends this placeholder with attachment-only messages; the chips say it instead.
  const combinedText = joined === 'Attached files' && mediaParts.length > 0 ? '' : joined;
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
          <AttachmentGroup className={styles.media} data-with-text={!!combinedText}>
            {mediaParts.map((part, index) => (
              <MessageAttachment
                key={`${part.attachmentId}-${index}`}
                part={part}
                attachment={part.attachmentId ? attachmentsById[part.attachmentId] : undefined}
                onPreview={setLightboxUrl}
              />
            ))}
          </AttachmentGroup>
        ) : null}
        {combinedText ? (
          <div ref={bubbleRef} data-user-bubble="" className={styles.bubble} style={isSendFlightTarget(turnKey,combinedText)?{visibility:'hidden',opacity:0}:undefined}>
            {combinedText}
          </div>
        ) : null}
        {combinedText ? <button type="button" className={`${actionStyles.action} ${styles.copy}`} data-testid="user-copy-button" aria-label={copied ? 'Copied' : 'Copy message'} onClick={async () => { await navigator.clipboard.writeText(combinedText); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button> : null}
      </div>

      {lightboxUrl ? (
        <div role="dialog" aria-label="Image preview" className={styles.lightbox} onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Full size attachment" />
        </div>
      ) : null}
    </>
  );
};
