import React from 'react';
import { useAppCatalog } from '../../hooks/useAppCatalog';
import { useAppConnect } from '../../hooks/useAppConnect';
import { useAppConnections } from '../../hooks/useAppConnections';
import { appState } from '../../lib/apps';
import { usePraxisStore } from '../../state/store.js';
import { AppCard } from './AppCard';
import { ScreenBody, ScreenButton, TaskError, useScreenTask } from './ScreenUI.js';
import grid from './AppDirectory.module.css';
import styles from './Screen.module.css';

/** Settings → App Directory: all Composio apps, their connection state, and this chat's toggles. */
export function AppDirectoryScreen() {
  const store = usePraxisStore();
  const connections = useAppConnections();
  const actions = useAppConnect();
  const toggle = useScreenTask();
  const toggleWrites = React.useRef(new Map<string, Promise<void>>());
  const [query, setQuery] = React.useState('');
  const catalog = useAppCatalog(query);
  const chat = store.activeChat;
  const trimmedQuery = query.trim();

  const toggleChat = (toolkit: string, enabled: boolean) => {
    if (!chat) return;
    const key = `${chat.id}:${toolkit}`;
    const previous = toggleWrites.current.get(key) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => toggle.run(() => store.setChatApp(chat.id, toolkit, enabled)));
    toggleWrites.current.set(key, write);
    void write.finally(() => { if (toggleWrites.current.get(key) === write) toggleWrites.current.delete(key); });
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
      {catalog.state === 'error' ? (
        <div className={grid.feedback} role="alert">
          <p className={styles.error}>Couldn’t load the app directory.</p>
          <ScreenButton tone="secondary" onClick={catalog.retry}>Try again</ScreenButton>
        </div>
      ) : catalog.state === 'loading' && catalog.items.length === 0 ? (
        <ul className={grid.grid} aria-label="Loading apps" aria-busy="true" data-testid="app-directory-loading">
          {Array.from({ length: 6 }, (_, index) => <li key={index} className={grid.card} aria-hidden="true"><span className={grid.skeleton} /><span className={grid.skeleton} /><span className={grid.skeleton} /></li>)}
        </ul>
      ) : catalog.items.length ? (
        <>
          <ul className={grid.grid} aria-label="Apps" data-testid="app-directory">
            {catalog.items.map((app) => (
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
          {catalog.hasMore ? (
            <div className={grid.footer}>
              <ScreenButton
                tone="secondary"
                disabled={catalog.loadingMore}
                onClick={catalog.loadMore}
              >
                {catalog.loadingMore ? 'Loading more…' : `Load more apps (${catalog.items.length} of ${catalog.totalItems})`}
              </ScreenButton>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.empty} role="status">
          {trimmedQuery ? `No apps match “${trimmedQuery}”.` : 'No apps available.'}
        </p>
      )}
    </ScreenBody>
  );
}
