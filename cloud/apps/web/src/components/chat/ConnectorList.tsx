import { ScrollBlur } from '@praxis/glass';
import React from 'react';
import { ChevronLeft, Search, X } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { Switch } from '../ui/controls';
import { RowGroup, rowClass } from '../ui/RowGroup';
import styles from './ConnectorList.module.css';

export interface ConnectorListProps {
  onBack: () => void;
  onOpenSettings: () => void;
  autoFocus?: boolean;
}

/** Nested composer-tray page for toggling active connectors and filtering by name. */
export function ConnectorList({ onBack, onOpenSettings, autoFocus = true }: ConnectorListProps) {
  const store = usePraxisStore();
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useLayoutEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const enabledConnectors = React.useMemo(
    () => store.connectors.filter((c) => c.enabled),
    [store.connectors],
  );
  const needle = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      needle
        ? enabledConnectors.filter((c) => c.name.toLowerCase().includes(needle))
        : enabledConnectors,
    [enabledConnectors, needle],
  );

  return (
    <div className={styles.root} data-testid="tray-connectors-view">
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
            aria-label="Search connectors"
            placeholder="Search connectors…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className={styles.clear}
              aria-label="Clear connector search"
              onClick={() => setQuery('')}
            >
              <X size={16} />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          className={styles.manage}
          data-testid="tray-connectors-manage"
          onClick={onOpenSettings}
        >
          Manage
        </button>
      </div>

      <ScrollBlur className={styles.list} height="100%" scrimHeight={16}>
        {enabledConnectors.length === 0 ? (
          <div className={styles.empty} data-testid="tray-connectors-empty">
            <p className={styles.note}>No active connectors.</p>
            <p className={styles.hint}>Use Manage to enable or add connectors in Settings.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className={styles.note} data-testid="tray-connectors-no-match">
            No matching connectors.
          </p>
        ) : (
          <div className={styles.rowsWrap}>
            <RowGroup>
              {filtered.map((connector) => (
                <label
                  key={connector.id}
                  className={`${rowClass(!!store.activeChat)} ${styles.row}`}
                  data-testid={`tray-connector-row-${connector.id}`}
                >
                  <span className={styles.rowCopy}>
                    <span className={styles.rowTitle}>{connector.name}</span>
                  </span>
                  <Switch
                    label={connector.name}
                    checked={!store.activeChat?.disabledConnectorIds.includes(connector.id)}
                    disabled={!store.activeChat}
                    onChange={(checked) =>
                      void store.toggleChatConnector(store.activeChat!.id, connector.id, checked)
                    }
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
