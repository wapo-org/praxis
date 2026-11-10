import { SNAP, usePress } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { ArrowUp, Mic, Plus, Square } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './ComposerBar.module.css';

const MAX_INPUT_HEIGHT = 200;

/** + / textarea / mic-or-send-or-stop, per the iOS composer. */
export function ComposerBar({
  inputRef,
  text,
  onTextChange,
  onKeyDown,
  recording,
  transcribing,
  onToggleVoice,
  onSend,
  attachmentCount,
  voiceSupported = true,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  recording: boolean;
  transcribing: boolean;
  onToggleVoice: () => void;
  onSend: () => void;
  attachmentCount: number;
  /** No Web Speech API (Firefox): no mic; the send button holds the slot. */
  voiceSupported?: boolean;
}) {
  const { plusTrayOpen, setPlusTrayOpen, inlineModelSearchActive, activeLiveRun, cancelActiveRun } =
    usePraxisStore();
  const pressProps = usePress();
  const isRunning =
    activeLiveRun && ['running', 'awaitingApproval', 'awaitingElicitation'].includes(activeLiveRun.run.status);
  const hasInput = text.length > 0 || attachmentCount > 0;
  const canSend = !!text.trim() || attachmentCount > 0;
  const showMic = voiceSupported && !isRunning && (!hasInput || recording || transcribing);

  // Auto-grow: measure once per text change, never per frame.
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text, inputRef]);

  return (
    <div className={styles.bar}>
      <motion.button
        type="button"
        className={`${styles.round} ${styles.secondary}`}
        aria-label="Open attachments and controls"
        aria-expanded={plusTrayOpen}
        data-testid="composer-plus-button"
        onClick={() => setPlusTrayOpen(!plusTrayOpen)}
        {...pressProps}
      >
        <motion.span className={styles.plusIcon} initial={false} animate={{ rotate: plusTrayOpen ? 45 : 0 }} transition={SNAP}>
          <Plus size={20} />
        </motion.span>
      </motion.button>

      <textarea
        ref={inputRef}
        rows={1}
        className={styles.input}
        data-testid="composer-input"
        aria-label={inlineModelSearchActive ? 'Search models' : 'Message Praxis'}
        placeholder={
          inlineModelSearchActive
            ? 'Type to filter models…'
            : recording
              ? 'Listening…'
              : transcribing
                ? 'Transcribing voice…'
                : 'Ask or execute…'
        }
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className={styles.trailingSlot}>
        {isRunning ? (
          <motion.button
            type="button"
            className={`${styles.round} ${styles.primary} ${styles.slotButton}`}
            aria-label="Stop generating"
            data-testid="composer-stop-button"
            onClick={() => void cancelActiveRun()}
            {...pressProps}
          >
            <Square size={16} fill="currentColor" />
          </motion.button>
        ) : (
          <>
            <motion.button
              type="button"
              className={`${styles.round} ${styles.secondary} ${styles.slotButton}`}
              aria-label={recording ? 'Stop voice input' : 'Voice input'}
              aria-pressed={recording}
              aria-hidden={!showMic || undefined}
              tabIndex={showMic ? 0 : -1}
              disabled={!showMic}
              data-testid="composer-voice-button"
              data-recording={recording || undefined}
              data-hidden={!showMic ? 'true' : undefined}
              onClick={onToggleVoice}
              {...pressProps}
            >
              {recording ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
            </motion.button>
            <motion.button
              type="button"
              className={`${styles.round} ${styles.primary} ${styles.slotButton}`}
              aria-label="Send message"
              aria-hidden={showMic || undefined}
              tabIndex={showMic ? -1 : 0}
              disabled={showMic || !canSend}
              data-testid="composer-send-button"
              data-hidden={showMic ? 'true' : undefined}
              onClick={onSend}
              {...pressProps}
            >
              <ArrowUp size={20} />
            </motion.button>
          </>
        )}
      </div>
    </div>
  );
}
