import { ComposerBar } from './ComposerBar';
import { cancelSendFlight, launchSendFlight } from './chatMotion';
import { useModelSearch } from '../../lib/useModelSearch';
import React from 'react';
import type { Attachment } from '@praxis/protocol';
import { GlassSurface } from '@praxis/glass';
import { usePraxisStore } from '../../state/store';
import { PlusTray } from './PlusTray';
import { AttachmentChip } from './AttachmentChip';
import { attachmentLimit } from './attachmentInfo';
import { registerComposerInput } from './composerFocus';
import { useSpeechInput } from './useSpeechInput';

interface QueuedFile {
  key: string;
  name: string;
  mediaType: string;
  size: number;
  status: 'uploading' | 'ready' | 'blocked' | 'failed';
  attachment?: Attachment;
  note?: string;
  level?: 'warn' | 'block';
}
import styles from './Composer.module.css';

export const Composer: React.FC = () => {
  const {
    setPlusTrayOpen,
    inlineModelSearchActive,
    setInlineModelSearchActive,
    selectedProviderId,
    selectedModelId,
    setSelectedModel,
    cacheModels,
    sendMessage,
    uploadFiles,
  } = usePraxisStore();

  const [text, setText] = React.useState('');
  const [queued, setQueuedState] = React.useState<QueuedFile[]>([]);
  // The queue also lives in a ref updated in the same call, so a send pressed before React re-renders sees
  // the files just picked; send waits for uploads in flight instead of ignoring the press (WP-J2).
  const queueRef = React.useRef<QueuedFile[]>([]);
  const setQueued = React.useCallback((next: QueuedFile[] | ((prev: QueuedFile[]) => QueuedFile[])) => {
    queueRef.current = typeof next === 'function' ? next(queueRef.current) : next;
    setQueuedState(queueRef.current);
  }, []);
  const uploadsRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const sendingRef = React.useRef(false);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    registerComposerInput(textareaRef.current);
    return () => registerComposerInput(null);
  }, []);

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
    e.target.value = '';
    if (files.length === 0) return;
    setMediaError('');
    const entries = files.map((file): QueuedFile => {
      const limit = attachmentLimit({ name: file.name, mediaType: file.type || 'application/octet-stream', size: file.size });
      return {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        status: limit?.level === 'block' ? 'blocked' : 'uploading',
        note: limit?.message,
        level: limit?.level,
      };
    });
    setQueued((prev) => [...prev, ...entries]);
    const work = Promise.all(
      files.map(async (file, i) => {
        const entry = entries[i]!;
        if (entry.status === 'blocked') return;
        try {
          const [attachment] = await uploadFiles([file]);
          setQueued((prev) => prev.map((q) => (q.key === entry.key ? { ...q, status: 'ready', attachment } : q)));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Upload failed';
          setQueued((prev) => prev.map((q) => (q.key === entry.key ? { ...q, status: 'failed', note: `Couldn’t upload: ${message}`, level: 'block' } : q)));
        }
      }),
    );
    uploadsRef.current = Promise.all([uploadsRef.current, work]);
    await work;
  };

  const modelSearch = useModelSearch(text, inlineModelSearchActive);
  const handleSend = async () => {
    if (sendingRef.current) return;
    const trimmed = text.trim();
    if (!trimmed && queueRef.current.length === 0) return;
    if (queueRef.current.some((q) => q.status === 'uploading')) {
      sendingRef.current = true;
      try {
        await uploadsRef.current;
      } finally {
        sendingRef.current = false;
      }
    }
    const ready = queueRef.current.flatMap((q) => (q.status === 'ready' && q.attachment ? [q.attachment] : []));
    if (!trimmed && ready.length === 0) return;

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

    const attachmentIds = ready.map((a) => a.id);
    if (trimmed) {
      launchSendFlight(textareaRef.current, trimmed);
    }
    setText('');
    setQueued([]);
    setPlusTrayOpen(false);
    try {
      await sendMessage(trimmed, { attachmentIds });
    } catch {
      cancelSendFlight();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === 'Escape' && inlineModelSearchActive) {
      setInlineModelSearchActive(false);
    }
  };

  // Web Speech API: interim words stream into the field; the mic turns into a stop control while listening.
  const speech = useSpeechInput({ text, onText: setText, onError: setMediaError });

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
              </span>
            </button>
          ))}
        </GlassSurface>
      ) : null}

      <PlusTray onPickFiles={handlePickFiles} />

      <GlassSurface material="regular" style={{ '--glass-radius': 'var(--radius-composer)' } as React.CSSProperties} data-testid="composer-surface" className={styles.pill}>
        {queued.length > 0 ? (
          <div data-testid="composer-attachments-strip" className={styles.attachments}>
            {queued.map((q) => (
              <AttachmentChip
                key={q.key}
                testId="composer-attachment-chip"
                name={q.name}
                mediaType={q.mediaType}
                size={q.size}
                status={q.status === 'uploading' ? 'Uploading…' : undefined}
                note={q.note}
                noteLevel={q.level}
                onRemove={() => setQueued((prev) => prev.filter((x) => x.key !== q.key))}
              />
            ))}
          </div>
        ) : null}

        <ComposerBar
          inputRef={textareaRef}
          text={text}
          onTextChange={setText}
          onKeyDown={handleKeyDown}
          recording={speech.listening}
          transcribing={false}
          voiceSupported={speech.supported}
          onToggleVoice={speech.toggle}
          onSend={() => void handleSend()}
          attachmentCount={queued.filter((q) => q.status === 'ready' || q.status === 'uploading').length}
        />
      </GlassSurface>
    </div>
  );
};
