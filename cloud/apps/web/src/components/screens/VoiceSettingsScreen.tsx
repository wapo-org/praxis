import React from 'react';
import { Check, Mic } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  Field,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  useScreenTask,
} from './ScreenUI.js';

const SPEECH_MODELS = [
  { id: 'whisper-large-v3-turbo', detail: 'Fast, multilingual transcription' },
  { id: 'whisper-large-v3', detail: 'Multilingual transcription' },
  { id: 'distil-whisper-large-v3-en', detail: 'English transcription' },
];

export function VoiceSettingsScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [model, setModel] = React.useState(
    store.preferences?.voice.model ?? SPEECH_MODELS[0]!.id,
  );
  const [language, setLanguage] = React.useState(
    store.preferences?.voice.language ?? '',
  );
  const [apiKey, setApiKey] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const recordings = Object.values(store.attachmentsById).filter((attachment) =>
    attachment.mediaType.startsWith('audio/'),
  );
  return (
    <ScreenBody>
      <form
        className="screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await store.updatePreferences({
              voice: {
                model,
                language: language.trim(),
                ...(apiKey ? { apiKey } : {}),
              },
            });
            setApiKey('');
            setSaved(true);
          });
        }}
      >
        <TaskError error={task.error} />
        <Section
          title="Groq API key"
          hint="Leave blank to keep the saved key. Recordings are sent to Groq when you request transcription."
        >
          <Field label="API key (optional)">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaved(false);
              }}
              placeholder={
                store.preferences?.voice.configured
                  ? 'Saved — type to replace'
                  : 'gsk_…'
              }
              autoComplete="new-password"
            />
          </Field>
          {store.preferences?.voice.configured ? (
            <span className="screen-badge screen-badge--success">
              Key configured
            </span>
          ) : null}
        </Section>
        <Section title="Speech model">
          <Card>
            {SPEECH_MODELS.map((item) => (
              <label className="screen-row" key={item.id}>
                <input
                  type="radio"
                  name="speech-model"
                  value={item.id}
                  checked={model === item.id}
                  onChange={() => {
                    setModel(item.id);
                    setSaved(false);
                  }}
                />
                <span className="screen-row-copy">
                  <span className="screen-mono">{item.id}</span>
                  <span className="screen-detail">{item.detail}</span>
                </span>
                {model === item.id ? (
                  <Check size={16} aria-hidden="true" />
                ) : null}
              </label>
            ))}
          </Card>
        </Section>
        <Field
          label="Language hint"
          hint="Optional language code, such as en, pl, or uk. Leave blank to detect automatically."
        >
          <input
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              setSaved(false);
            }}
            placeholder="Detect automatically"
            maxLength={32}
            autoCapitalize="none"
          />
        </Field>
        <ScreenButton type="submit" tone="primary" disabled={task.busy}>
          {task.busy ? 'Saving…' : 'Save voice settings'}
        </ScreenButton>
        {saved ? (
          <p className="screen-success" role="status">
            Voice settings saved.
          </p>
        ) : null}
      </form>
      <Section title="Voice recordings">
        {recordings.length ? (
          <Card>
            {recordings.map((recording) => (
              <div className="screen-row" key={recording.id}>
                <Mic size={17} aria-hidden="true" />
                <span className="screen-row-copy">
                  <span>{recording.name}</span>
                  <span className="screen-detail">
                    {Math.max(1, Math.round(recording.size / 1024))} KB
                  </span>
                  {recording.url ? (
                    <audio
                      controls
                      preload="none"
                      src={recording.url}
                      aria-label={`Play ${recording.name}`}
                      style={{ width: '100%', maxWidth: 340 }}
                    />
                  ) : (
                    <span className="screen-footnote">
                      Audio playback is unavailable for this recording.
                    </span>
                  )}
                </span>
              </div>
            ))}
          </Card>
        ) : (
          <p className="screen-empty">
            No recordings. Audio recordings attached to your conversations
            appear here.
          </p>
        )}
      </Section>
    </ScreenBody>
  );
}
