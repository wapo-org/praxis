import { usePress } from '@praxis/glass';
import { m as motion } from 'framer-motion';
import React from 'react';
import { ArrowUp, Camera, Mic, Plus, Square } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './ComposerBar.module.css';

const MAX_INPUT_HEIGHT = 200;

/** + / textarea / camera / mic / send-or-stop, per the iOS composer. */
export function ComposerBar({
  inputRef,
  text,
  onTextChange,
  onKeyDown,
  recording,
  transcribing,
  onCamera,
  onToggleVoice,
  onSend,
  attachmentCount,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  recording: boolean;
  transcribing: boolean;
  onCamera: () => void;
  onToggleVoice: () => void;
  onSend: () => void;
  attachmentCount: number;
}) {
  const { plusTrayOpen, setPlusTrayOpen, inlineModelSearchActive, activeLiveRun, cancelActiveRun } =
    usePraxisStore();
  const pressProps = usePress();
  const isRunning =
    activeLiveRun && ['running', 'awaitingApproval', 'awaitingElicitation'].includes(activeLiveRun.run.status);
  const canSend = !!text.trim() || attachmentCount > 0;

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
        className={styles.round}
        aria-label="Open attachments and controls"
        aria-expanded={plusTrayOpen}
        data-testid="composer-plus-button"
        onClick={() => setPlusTrayOpen(!plusTrayOpen)}
        {...pressProps}
      >
        <span className={styles.plusIcon} data-open={plusTrayOpen}>
          <Plus size={20} />
        </span>
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
              ? 'Listening… tap mic to finish'
              : transcribing
                ? 'Transcribing voice…'
                : 'Plan, ask, build…'
        }
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <motion.button
        type="button"
        className={`composer-camera ${styles.round}`}
        aria-label="Camera"
        onClick={onCamera}
        {...pressProps}
      >
        <Camera size={18} />
      </motion.button>
      <motion.button
        type="button"
        className={styles.round}
        aria-label={recording ? 'Stop voice recording' : 'Voice input'}
        data-testid="composer-voice-button"
        data-recording={recording || undefined}
        onClick={onToggleVoice}
        {...pressProps}
      >
        <Mic size={18} />
      </motion.button>

      {isRunning ? (
        <motion.button
          type="button"
          className={styles.round}
          aria-label="Stop generating"
          data-testid="composer-stop-button"
          onClick={() => void cancelActiveRun()}
          {...pressProps}
        >
          <Square size={16} fill="currentColor" />
        </motion.button>
      ) : (
        <motion.button
          type="button"
          className={styles.round}
          aria-label="Send message"
          data-testid="composer-send-button"
          hidden={!canSend}
          disabled={!canSend}
          onClick={onSend}
          {...pressProps}
        >
          <ArrowUp size={20} />
        </motion.button>
      )}
    </div>
  );
}
