import React from 'react';
import { Plus, Camera, Mic, Square, ArrowUp } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
export function ComposerBar({ inputRef, text, onTextChange, onKeyDown, recording, transcribing, onCamera, onToggleVoice, onSend, attachmentCount }: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>; text: string; onTextChange: (text: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>; recording: boolean; transcribing: boolean;
  onCamera: () => void; onToggleVoice: () => void; onSend: () => void; attachmentCount: number;
}) {
  const { plusTrayOpen, setPlusTrayOpen, inlineModelSearchActive, activeLiveRun, cancelActiveRun } = usePraxisStore();
  const isRunning = activeLiveRun && ['running', 'awaitingApproval', 'awaitingElicitation'].includes(activeLiveRun.run.status);
  return (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
          }}
        >
          {/* Plus / Tray Toggle Button */}
          <button
            type="button"
            aria-label="Open attachments and controls"
            data-testid="composer-plus-button"
            onClick={() => setPlusTrayOpen(!plusTrayOpen)}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: '0.5px solid var(--paper-hairline)',
              background: 'var(--paper-ink)',
              color: 'var(--paper-canvas)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              fontWeight: 400,
              cursor: 'pointer',
              flexShrink: 0,
              transform: plusTrayOpen ? 'rotate(45deg)' : 'rotate(0deg)',
              transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <Plus size={20} />
          </button>

          {/* Auto-growing Textarea */}
          <textarea
            ref={inputRef}
            rows={1}
            data-testid="composer-input"
            aria-label={inlineModelSearchActive ? 'Search models' : 'Message Praxis'}
            placeholder={
              inlineModelSearchActive
                ? 'Type to filter models...'
                : recording
                  ? 'Listening... tap mic to finish'
                  : transcribing
                    ? 'Transcribing voice...'
                    : 'Plan, ask, build…'
            }
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            style={{
              flex: 1,
              minHeight: 36,
              maxHeight: 160,
              padding: '7px 4px',
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: 'var(--paper-ink)',
              fontFamily: 'var(--font-sans)',
              fontSize: 16,
              lineHeight: '22px',
            }}
          />

          <button type="button" className="composer-camera" aria-label="Camera" onClick={onCamera}><Camera size={21} /></button>
          {/* Voice Input Button */}
          <button
            type="button"
            aria-label={recording ? 'Stop voice recording' : 'Voice input'}
            data-testid="composer-voice-button"
            onClick={onToggleVoice}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: '0.5px solid var(--paper-hairline)',
              background: recording ? 'var(--paper-danger)' : 'var(--paper-fill-1)',
              color: recording ? '#FFFFFF' : 'var(--paper-ink-2)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Mic size={19} />
          </button>

          {/* Send or Stop Button */}
          {isRunning ? (
            <button
              type="button"
              aria-label="Stop generating"
              data-testid="composer-stop-button"
              onClick={() => void cancelActiveRun()}
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: 'none',
                background: 'var(--paper-ink)',
                color: 'var(--paper-canvas)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send message"
              data-testid="composer-send-button"
              hidden={!text.trim() && attachmentCount === 0}
              disabled={!text.trim() && attachmentCount === 0}
              onClick={onSend}
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: 'none',
                background:
                  text.trim() || attachmentCount > 0
                    ? 'var(--paper-ink)'
                    : 'var(--paper-fill-2)',
                color:
                  text.trim() || attachmentCount > 0
                    ? 'var(--paper-canvas)'
                    : 'var(--paper-ink-3)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 600,
                cursor:
                  text.trim() || attachmentCount > 0 ? 'pointer' : 'default',
                flexShrink: 0,
                transition: 'background 150ms ease, transform 150ms ease',
              }}
            >
              <ArrowUp size={20} />
            </button>
          )}
        </div>
  );
}
