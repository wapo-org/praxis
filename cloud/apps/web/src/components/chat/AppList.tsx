import { ScrollBlur } from '@praxis/glass';
import { COMPOSIO_APPS, composioEnabledInChat } from '@praxis/protocol';
import React from 'react';
import type { AppConnections } from '../../hooks/useAppConnections';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { ChevronLeft, Search, X } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { Switch } from '../ui/controls';
import { RowGroup, rowClass } from '../ui/RowGroup';
import styles from './AppList.module.css';

export interface AppListProps {
  connections: AppConnections;
  onBack: () => void;
  onOpenDirectory: () => void;
  autoFocus?: boolean;
}

/** Nested composer-tray page: the connected apps, each with this chat's on/off switch. */
export function AppList({ connections, onBack, onOpenDirectory, autoFocus = true }: AppListProps) {
  const store = usePraxisStore();
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  useAutoFocus(inputRef, autoFocus);

  const connected = COMPOSIO_APPS.filter(
    (app) => connections.state === 'ready' && connections.byToolkit.get(app.toolkit) === 'connected',
  );
  const needle = query.trim().toLowerCase();
  const filtered = needle ? connected.filter((app) => app.name.toLowerCase().includes(needle)) : connected;
  const chat = store.activeChat;

  return (
    <div className={styles.root} data-testid="tray-apps-view">
      <div className={styles.header}>
        <button type="button" className={styles.back} aria-label="Back" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <label className={styles.search}>
          <Search size={16} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            aria-label="Search apps"
            placeholder="Search apps…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className={styles.clear} aria-label="Clear app search" onClick={() => setQuery('')}>
              <X size={16} />
            </button>
          ) : null}
        </label>
        <button type="button" className={styles.manage} data-testid="tray-apps-manage" onClick={onOpenDirectory}>
          Manage
        </button>
      </div>

      <ScrollBlur className={styles.list} height="100%" scrimHeight={16}>
        {connected.length === 0 ? (
          <div className={styles.empty} data-testid="tray-apps-empty">
            <p className={styles.note}>No connected apps.</p>
            <p className={styles.hint}>Use Manage to connect apps in the App Directory.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className={styles.note} data-testid="tray-apps-no-match">
            No matching apps.
          </p>
        ) : (
          <div className={styles.rowsWrap}>
            <RowGroup>
              {filtered.map((app) => (
                <label
                  key={app.toolkit}
                  className={`${rowClass(!!chat)} ${styles.row}`}
                  data-testid={`tray-app-row-${app.toolkit}`}
                >
                  <span className={styles.rowCopy}>
                    <span className={styles.rowTitle}>{app.name}</span>
                  </span>
                  <Switch
                    label={app.name}
                    checked={chat ? composioEnabledInChat(chat, app.toolkit) : true}
                    disabled={!chat}
                    onChange={(enabled) => {
                      if (!chat) return;
                      store.setChatApp(chat.id, app.toolkit, enabled).catch(() => {
                        store.reportError(`Couldn’t change ${app.name} for this chat. Try again.`);
                      });
                    }}
                  />
                </label>
              ))}
            </RowGroup>
          </div>
        )}
      </ScrollBlur>
    </div>
  );
}
