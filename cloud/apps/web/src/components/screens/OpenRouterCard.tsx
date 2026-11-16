import React from 'react';
import { ExternalLink, RefreshCw, Trash2 } from '../../lib/icons';
import { formatCredit } from '../../lib/models';
import { beginOpenRouterConnect } from '../../lib/openrouter-pkce';
import { usePraxisStore } from '../../state/store.js';
import styles from './Screen.module.css';
import { Card, Field, ScreenButton, Section, TaskError, useScreenTask } from './ScreenUI.js';

/** `navigate` leaves the app for OpenRouter's sign-in page; tests replace it. */
export function OpenRouterCard({
  navigate = (url) => window.location.assign(url),
}: {
  navigate?: (url: string) => void;
}) {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [pasting, setPasting] = React.useState(false);
  const [apiKey, setApiKey] = React.useState('');
  const key = store.modelKey;

  const connect = () =>
    void task.run(async () => {
      navigate(await beginOpenRouterConnect());
    });
  const paste = (event: React.FormEvent) => {
    event.preventDefault();
    void task.run(async () => {
      await store.connectModelKey({ method: 'paste', apiKey: apiKey.trim() });
      setApiKey('');
      setPasting(false);
    });
  };

  const pasteForm = (
    <form className={styles.form} onSubmit={paste} data-testid="openrouter-paste-form">
      <Field label="OpenRouter API key" hint="Starts with sk-or-. It is stored encrypted and never shown again.">
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-or-…"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>
      <div className={styles.actions}>
        <ScreenButton type="submit" tone="primary" disabled={task.busy || !apiKey.trim()}>
          Save key
        </ScreenButton>
        <ScreenButton
          disabled={task.busy}
          onClick={() => {
            setPasting(false);
            setApiKey('');
          }}
        >
          Cancel
        </ScreenButton>
      </div>
    </form>
  );

  const connectActions = pasting ? (
    pasteForm
  ) : (
    <>
      <ScreenButton tone="primary" disabled={task.busy} onClick={connect}>
        <ExternalLink size={16} />
        {key ? 'Reconnect OpenRouter' : 'Connect OpenRouter'}
      </ScreenButton>
      <button type="button" className={styles.textButton} disabled={task.busy} onClick={() => setPasting(true)}>
        Paste a key instead
      </button>
    </>
  );

  if (!key)
    return (
      <Section
        title="OpenRouter"
        hint="Connecting lets Praxis send your chats to OpenRouter with your key. Model usage is billed to your OpenRouter account."
      >
        <p className={styles.intro} data-testid="openrouter-disconnected">
          Praxis runs models through your own OpenRouter account. Connect it to start chatting.
        </p>
        <TaskError error={task.error} />
        {connectActions}
      </Section>
    );

  const credit = formatCredit(key);
  return (
    <Section title="OpenRouter" hint="Model usage is billed to your OpenRouter account.">
      {key.lastError ? (
        <p className={styles.error} role="alert" data-testid="openrouter-key-error">
          OpenRouter rejected this key: {key.lastError} Reconnect to keep chatting.
        </p>
      ) : null}
      <TaskError error={task.error} />
      <Card>
        <div className={styles.row} data-testid="openrouter-connected">
          <span className={styles.rowCopy}>
            <span>Key</span>
            <span className={styles.detail}>{key.maskedKey}</span>
          </span>
          <span className={`${styles.badge} ${key.lastError ? styles.badgeError : styles.badgeSuccess}`}>
            {key.lastError ? 'Needs attention' : 'Connected'}
          </span>
        </div>
        {key.label ? (
          <div className={styles.row}>
            <span className={styles.rowCopy}>
              <span>Label</span>
              <span className={styles.detail}>{key.label}</span>
            </span>
          </div>
        ) : null}
        {credit ? (
          <div className={styles.row}>
            <span className={styles.rowCopy}>
              <span>Credit</span>
              <span className={styles.detail}>{credit}</span>
            </span>
          </div>
        ) : null}
      </Card>
      <div className={styles.actions}>
        <ScreenButton disabled={task.busy} onClick={() => void task.run(() => store.checkModelKey())}>
          <RefreshCw size={16} />
          Check
        </ScreenButton>
        <ScreenButton
          tone="destructive"
          disabled={task.busy}
          onClick={() => void task.run(() => store.disconnectModelKey())}
        >
          <Trash2 size={16} />
          Disconnect
        </ScreenButton>
      </div>
      {key.lastError || pasting ? connectActions : null}
    </Section>
  );
}
