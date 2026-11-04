import { GlassSurface, popIn, usePreset } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { createPortal } from 'react-dom';
import { FileText, Globe, Link, Mic, Paperclip, Wrench } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import styles from './ConsentPopover.module.css';

/**
 * The AI data-consent step as a small anchored popover above the composer.
 * It keeps blocking sends until answered (the send path returns without
 * sending while it is open), but it is not a modal: no scrim, no focus trap,
 * no background inertness. Escape does not dismiss it, and the composer
 * stays reachable so the user can see what would be sent.
 */
export function ConsentPopover() {
  const store = usePraxisStore();
  const prompt = store.pendingConsentPrompt;
  const box = useAnchorBox(!!prompt);
  const pop = usePreset(popIn);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Move keyboard focus into the popover on open; restore it on close.
  React.useEffect(() => {
    if (!prompt || !box) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [prompt, box]);

  if (!prompt || !box) return null;

  const cancel = () => {
    prompt.onCancel?.();
    store.setPendingConsentPrompt(null);
  };
  const voice = prompt.purpose === 'voice';
  const items = voice
    ? [{ icon: <Mic size={18} />, title: 'Voice recordings', detail: 'The audio you recorded, to turn into text.' }]
    : prompt.purpose === 'vision'
      ? [
          { icon: <Paperclip size={18} />, title: 'Images', detail: 'The images you ask this model to read.' },
          { icon: <FileText size={18} />, title: 'Questions about the image', detail: 'The context needed to describe and understand your image.' },
        ]
      : prompt.purpose === 'connector'
        ? [
            { icon: <Wrench size={18} />, title: 'Tool requests', detail: 'The tool names and arguments sent to this connector.' },
            { icon: <Link size={18} />, title: 'Connector data', detail: 'Results returned by this connector may be shared with your chat provider.' },
        ]
        : [
            { icon: <FileText size={18} />, title: 'Your messages', detail: 'This chat’s messages so far, and each new one.' },
            { icon: <Paperclip size={18} />, title: 'Attachments', detail: 'Photos and files you add to the chat.' },
            { icon: <Wrench size={18} />, title: 'Tool results', detail: 'What the agent’s tools return, like web pages or code output.' },
            { icon: <Link size={18} />, title: 'Connector data', detail: 'What the connectors enabled for this chat return to the agent.' },
        ];

  return createPortal(
    // Scale lives on this parent; opacity goes on the glass so its blur fades with it.
    <motion.div
      className={styles.anchor}
      style={{ left: box.left, bottom: box.bottom }}
      initial={{ scale: pop.initial.scale }}
      animate={{ scale: 1 }}
      transition={pop.transition}
    >
      <GlassSurface
        ref={panelRef}
        material="thick"
        radius={20}
        role="dialog"
        aria-modal="false"
        aria-label="AI data sharing"
        data-testid="consent-popover"
        className={styles.panel}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={pop.transition}
      >
        <div className={styles.body}>
          <h2 className={styles.heading} id="consentTitle" data-testid="consentTitle">
            {voice
              ? 'Share this recording for transcription?'
              : prompt.purpose === 'vision'
                ? 'Share images with this model?'
                : prompt.purpose === 'connector'
                  ? 'Share data with this connector?'
                  : 'Share this chat with this provider?'}
          </h2>
          <p className={styles.host}>
            <Globe size={16} aria-hidden="true" />
            {prompt.host}
          </p>
          <p className={styles.intro}>{prompt.description}</p>
          <div className={styles.list}>
            {items.map((item) => (
              <div className={styles.row} key={item.title}>
                <span className={styles.rowIcon}>{item.icon}</span>
                <span className={styles.rowCopy}>
                  <strong>{item.title}</strong>
                  <span className={styles.detail}>{item.detail}</span>
                </span>
              </div>
            ))}
          </div>
          <p className={styles.footnote}>
            The service’s own terms and privacy policy apply to what it receives.
            You can withdraw permission in Settings → Data & privacy. Praxis then
            asks again before sending.
          </p>
          <button type="button" className={styles.primary} onClick={prompt.onAllow}>
            Allow
          </button>
          <button type="button" className={styles.secondary} onClick={cancel}>
            Cancel
          </button>
        </div>
      </GlassSurface>
    </motion.div>,
    document.body,
  );
}

function useAnchorBox(active: boolean) {
  const [box, setBox] = React.useState<{ left: number; bottom: number } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    const measure = () => {
      const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
      const rect = dock?.getBoundingClientRect();
      const width = Math.min(window.innerWidth - 24, 360);
      const left =
        rect && rect.width > 0
          ? Math.min(
              Math.max(rect.left, 12),
              Math.max(12, Math.min(window.innerWidth - 12 - width, rect.right - width)),
            )
          : Math.max(12, (window.innerWidth - width) / 2);
      const bottom =
        rect && rect.height > 0
          ? window.innerHeight - rect.top + 8
          : window.innerHeight - Math.max(96, window.innerHeight / 6);
      setBox({ left, bottom });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active]);
  return box;
}
