import React from 'react';
import { useAppConnect } from '../../hooks/useAppConnect';
import { useAppConnections } from '../../hooks/useAppConnections';
import { appState, searchApps } from '../../lib/apps';
import { usePraxisStore } from '../../state/store.js';
import { AppCard } from './AppCard';
import { ScreenBody, TaskError, useScreenTask } from './ScreenUI.js';
import grid from './AppDirectory.module.css';
import styles from './Screen.module.css';

/** Settings → App Directory: the curated Composio apps, their connection state, and this chat's toggles. */
export function AppDirectoryScreen() {
  const store = usePraxisStore();
  const connections = useAppConnections();
  const actions = useAppConnect();
  const toggle = useScreenTask();
  const [query, setQuery] = React.useState('');
  const apps = searchApps(query);
  const chat = store.activeChat;

  const toggleChat = (toolkit: string, enabled: boolean) => {
    if (!chat) return;
    void toggle.run(() => store.setChatApp(chat.id, toolkit, enabled));
  };

  return (
    <ScreenBody>
      <p className={styles.intro}>
        Connect an app to let the agent use it. You sign in on the app’s own page; Praxis keeps only whether it is
        connected.
      </p>
      <label className={grid.search}>
        <span className={grid.searchLabel}>Search apps</span>
        <input
          type="search"
          className={styles.search}
          placeholder="Gmail, Slack, GitHub…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <TaskError error={actions.error ?? toggle.error} />
      {connections.state === 'error' ? (
        <p className={styles.error} role="alert">Couldn’t load your connections. Reload the page to try again.</p>
      ) : null}
      {apps.length ? (
        <ul className={grid.grid} aria-label="Apps" data-testid="app-directory">
          {apps.map((app) => (
            <AppCard
              key={app.toolkit}
              app={app}
              state={appState(connections, app.toolkit)}
              chat={chat}
              actions={actions}
              onToggleChat={toggleChat}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.empty} role="status">No apps match “{query.trim()}”.</p>
      )}
    </ScreenBody>
  );
}
