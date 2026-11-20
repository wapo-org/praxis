import React from 'react';
import { composioEnabledInChat, type Chat, type ComposioApp } from '@praxis/protocol';
import type { AppConnect } from '../../hooks/useAppConnect';
import { APP_STATE_COPY, connectVerb, type AppState } from '../../lib/apps';
import { Switch } from '../ui/controls';
import { ScreenButton } from './ScreenUI.js';
import styles from './AppDirectory.module.css';

export function AppCard({ app, state, chat, actions, onToggleChat, toggling }: {
  app: ComposioApp;
  state: AppState;
  chat: Chat | null;
  actions: AppConnect;
  onToggleChat: (toolkit: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const nameId = React.useId();
  const busy = actions.busy === app.toolkit;
  const blocked = actions.busy !== null || state === 'loading' || state === 'unavailable';
  return (
    <li className={styles.card} aria-labelledby={nameId} data-testid={`app-card-${app.toolkit}`} data-state={state}>
      <div className={styles.head}>
        <span className={styles.mark} aria-hidden="true">{app.name.slice(0, 1)}</span>
        <div className={styles.copy}>
          <h3 id={nameId} className={styles.name}>{app.name}</h3>
          <p className={styles.description}>{app.description}</p>
        </div>
      </div>
      <p className={styles.status} data-state={state}>{APP_STATE_COPY[state]}</p>
      <div className={styles.actions}>
        {state === 'connected' ? (
          <ScreenButton
            tone="secondary"
            aria-label={`Disconnect ${app.name}`}
            disabled={blocked}
            onClick={() => actions.disconnect(app.toolkit)}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </ScreenButton>
        ) : (
          <ScreenButton
            tone="primary"
            aria-label={`${connectVerb(state)} ${app.name}`}
            disabled={blocked}
            onClick={() => actions.connect(app.toolkit)}
          >
            {busy ? 'Opening…' : connectVerb(state)}
          </ScreenButton>
        )}
      </div>
      {state === 'connected' ? <ChatToggle app={app} chat={chat} disabled={toggling} onToggle={onToggleChat} /> : null}
    </li>
  );
}

function ChatToggle({ app, chat, disabled, onToggle }: {
  app: ComposioApp;
  chat: Chat | null;
  disabled: boolean;
  onToggle: (toolkit: string, enabled: boolean) => void;
}) {
  if (!chat) return <p className={styles.note}>Open a chat to turn {app.name} on or off there.</p>;
  return (
    <label className={styles.toggle}>
      <span>Use in this chat</span>
      <Switch
        label={`Use ${app.name} in this chat`}
        checked={composioEnabledInChat(chat, app.toolkit)}
        disabled={disabled}
        onChange={(enabled) => onToggle(app.toolkit, enabled)}
      />
    </label>
  );
}
