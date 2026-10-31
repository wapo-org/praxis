import { ComposerBar } from './ComposerBar';
import { Photo, Paperclip, X } from '../../lib/icons';
import { useModelSearch } from '../../lib/useModelSearch';
import React from 'react';
import type { Attachment } from '@praxis/protocol';
import { DotMeter, GlassSurface } from '@praxis/glass';
import { usePraxisStore } from '../../state/store';
import { PlusTray } from './PlusTray';

export const Composer: React.FC = () => {
  const {
    plusTrayOpen,
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
    cancelActiveRun,
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

  const isRunning =
    activeLiveRun?.run.status === 'running' ||
    activeLiveRun?.run.status === 'awaitingApproval' ||
    activeLiveRun?.run.status === 'awaitingElicitation';

  const currentModel =
    models.find((m) => m.providerId === selectedProviderId && m.id === selectedModelId) ??
    models[0];

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
    <div
      data-testid="composer-dock"
      style={{
        width: '100%',
        maxWidth: 680,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        pointerEvents: 'auto',
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="composer-file-input"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {mediaError && <div role="alert">{mediaError}</div>}
      {/* Inline Model Search Results Overlay */}
      {inlineModelSearchActive && (
        <GlassSurface
          material="regular"
          intensity="medium"
          radius={20}
          data-testid="inline-model-search-results"
          style={{
            padding: 8,
            marginBottom: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 10px',
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--paper-ink-3)',
              textTransform: 'uppercase',
            }}
          >
            <span>Filter Models Inline</span>
            <button
              type="button"
              onClick={() => setInlineModelSearchActive(false)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--paper-ink-2)',
                fontSize: 11.5,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
          {modelSearch.error && <p role="alert">{modelSearch.error}</p>}
          {modelSearch.busy && <p role="status">Searching…</p>}
          {modelSearch.cursor && <button type="button" onClick={modelSearch.loadMore}>Load more models</button>}
          {inlineMatchingModels.map((m) => (
            <button
              key={`${m.providerId}-${m.id}`}
              type="button"
              data-testid={`inline-model-option-${m.id}`}
              onClick={() => {
                cacheModels([m]);
                setSelectedModel(m.providerId, m.id);
                setInlineModelSearchActive(false);
                setText('');
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 12,
                border: 'none',
                background:
                  m.providerId === selectedProviderId && m.id === selectedModelId
                    ? 'var(--paper-fill-1)'
                    : 'transparent',
                color: 'var(--paper-ink)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{m.displayName}</div>
                <div style={{ fontSize: 12, color: 'var(--paper-ink-2)' }}>
                  {m.tagline ?? m.providerId}
                </div>
              </div>
              {typeof m.speed === 'number' && <DotMeter value={m.speed} />}
            </button>
          ))}
        </GlassSurface>
      )}

      {/* Expandable Plus Tray */}
      <PlusTray onPickFiles={handlePickFiles} />

      {/* Main Floating Glass Composer Pill */}
      <GlassSurface
        material="regular"
        intensity="medium"
        radius={28}
        data-testid="composer-surface"
        style={{
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Queued Attachments Strip */}
        {(queuedAttachments.length > 0 || uploading) && (
          <div
            data-testid="composer-attachments-strip"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              overflowX: 'auto',
              padding: '4px 6px 2px',
            }}
          >
            {queuedAttachments.map((att) => (
              <div
                key={att.id}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  borderRadius: 12,
                  background: 'var(--paper-fill-1)',
                  border: '0.5px solid var(--paper-hairline)',
                  fontSize: 12.5,
                  color: 'var(--paper-ink)',
                }}
              >
                <span>{att.mediaType.startsWith('image/') ? <Photo size={16} /> : <Paperclip size={16} />}</span>
                <span
                  style={{
                    maxWidth: 120,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {att.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${att.name}`}
                  onClick={() =>
                    setQueuedAttachments((prev) => prev.filter((x) => x.id !== att.id))
                  }
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--paper-ink-3)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: 13,
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {uploading && (
              <span style={{ fontSize: 12, color: 'var(--paper-ink-3)' }}>Uploading...</span>
            )}
          </div>
        )}

        <ComposerBar inputRef={textareaRef} text={text} onTextChange={setText} onKeyDown={handleKeyDown}
          recording={recording} transcribing={transcribing} onCamera={() => handlePickFiles('image/*', true)}
          onToggleVoice={() => void handleToggleVoice()} onSend={() => void handleSend()} attachmentCount={queuedAttachments.length} />
      </GlassSurface>
    </div>
  );
};
