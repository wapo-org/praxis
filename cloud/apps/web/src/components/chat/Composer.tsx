import { ComposerBar } from './ComposerBar';
import { Photo, Paperclip, X } from '../../lib/icons';
import { useModelSearch } from '../../lib/useModelSearch';
import React from 'react';
import type { Attachment } from '@praxis/protocol';
import { DotMeter, GlassSurface } from '@praxis/glass';
import { usePraxisStore } from '../../state/store';
import { PlusTray } from './PlusTray';
import styles from './Composer.module.css';

export const Composer: React.FC = () => {
  const {
    setPlusTrayOpen,
    inlineModelSearchActive,
    setInlineModelSearchActive,
    models,
    selectedProviderId,
    selectedModelId,
    setSelectedModel,
    cacheModels,
    activeLiveRun,
    sendMessage,
    uploadFiles,
    transcribeAudioBlob,
  } = usePraxisStore();

  const [text, setText] = React.useState('');
  const [queuedAttachments, setQueuedAttachments] = React.useState<Attachment[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const audioChunksRef = React.useRef<BlobPart[]>([]);

  const handlePickFiles = (accept = '*/*', capture = false) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = accept;
    if (capture) {
      input.setAttribute('capture', 'environment');
    } else {
      input.removeAttribute('capture');
    }
    input.click();
  };

  const [mediaError, setMediaError] = React.useState('');
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(files);
      setQueuedAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const modelSearch = useModelSearch(text, inlineModelSearchActive);
  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && queuedAttachments.length === 0) return;

    if (inlineModelSearchActive) {
      const match = modelSearch.items[0];
      if (match) {
        cacheModels([match]);
        setSelectedModel(match.providerId, match.id);
      }
      setInlineModelSearchActive(false);
      setText('');
      return;
    }

    const attachmentIds = queuedAttachments.map((a) => a.id);
    setText('');
    setQueuedAttachments([]);
    setPlusTrayOpen(false);
    await sendMessage(trimmed || 'Attached files', { attachmentIds });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === 'Escape' && inlineModelSearchActive) {
      setInlineModelSearchActive(false);
    }
  };

  const handleToggleVoice = async () => {
    if (recording) {
      setRecording(false);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        return;
      }
      setMediaError('Microphone recording is not available in this browser.');
      return;
    }

    setRecording(true);
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    ) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];
        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          setTranscribing(true);
          try {
            const transcript = await transcribeAudioBlob(blob);
            if (transcript) {
              setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
            }
          } catch (err) {
            setMediaError(err instanceof Error ? err.message : 'Transcription failed');
          } finally {
            setTranscribing(false);
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
      } catch {
        setRecording(false);
        setMediaError('Unable to access microphone.');
      }
    }
  };

  const inlineMatchingModels = modelSearch.items;

  return (
    <div data-testid="composer-dock" className={styles.dock}>
      <input ref={fileInputRef} type="file" multiple data-testid="composer-file-input" onChange={handleFileChange} hidden />

      {mediaError ? (
        <div role="alert" className={styles.alert}>
          {mediaError}
        </div>
      ) : null}

      {inlineModelSearchActive ? (
        <GlassSurface material="thick" data-testid="inline-model-search-results" className={styles.models}>
          <div className={styles.modelsHeader}>
            <span>Filter models</span>
            <button type="button" onClick={() => setInlineModelSearchActive(false)}>
              Done
            </button>
          </div>
          {modelSearch.error ? <p role="alert" className={styles.note}>{modelSearch.error}</p> : null}
          {modelSearch.busy ? <p role="status" className={styles.note}>Searching…</p> : null}
          {modelSearch.cursor ? (
            <button type="button" className={styles.modelRow} onClick={modelSearch.loadMore}>
              Load more models
            </button>
          ) : null}
          {inlineMatchingModels.map((m) => (
            <button
              key={`${m.providerId}-${m.id}`}
              type="button"
              className={styles.modelRow}
              data-testid={`inline-model-option-${m.id}`}
              data-selected={m.providerId === selectedProviderId && m.id === selectedModelId}
              onClick={() => {
                cacheModels([m]);
                setSelectedModel(m.providerId, m.id);
                setInlineModelSearchActive(false);
                setText('');
              }}
            >
              <span className={styles.modelCopy}>
                <span className={styles.modelName}>{m.displayName}</span>
                <span className={styles.modelDetail}>{m.tagline ?? m.providerId}</span>
              </span>
              {typeof m.speed === 'number' ? <DotMeter value={m.speed} /> : null}
            </button>
          ))}
        </GlassSurface>
      ) : null}

      <PlusTray onPickFiles={handlePickFiles} />

      <GlassSurface material="regular" style={{ '--glass-radius': 'var(--radius-composer)' } as React.CSSProperties} data-testid="composer-surface" className={styles.pill}>
        {queuedAttachments.length > 0 || uploading ? (
          <div data-testid="composer-attachments-strip" className={styles.attachments}>
            {queuedAttachments.map((att) => (
              <div key={att.id} className={styles.attachment}>
                {att.mediaType.startsWith('image/') ? <Photo size={16} /> : <Paperclip size={16} />}
                <span className={styles.attachmentName}>{att.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => setQueuedAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            {uploading ? <span className={styles.note}>Uploading…</span> : null}
          </div>
        ) : null}

        <ComposerBar
          inputRef={textareaRef}
          text={text}
          onTextChange={setText}
          onKeyDown={handleKeyDown}
          recording={recording}
          transcribing={transcribing}
          onCamera={() => handlePickFiles('image/*', true)}
          onToggleVoice={() => void handleToggleVoice()}
          onSend={() => void handleSend()}
          attachmentCount={queuedAttachments.length}
        />
      </GlassSurface>
    </div>
  );
};
