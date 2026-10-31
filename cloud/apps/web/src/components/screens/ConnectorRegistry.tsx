import type { Connector } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import type { ConnectorCandidate } from '../../lib/api-x1';
import { usePraxisStore } from '../../state/store';
import {
  Card,
  Field,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  requireHttpUrl,
  useScreenTask,
} from './ScreenUI';
export function ConnectorRegistry() {
  const store = usePraxisStore(),
    task = useScreenTask();
  const [query, setQuery] = React.useState(''),
    [entries, setEntries] = React.useState<ConnectorCandidate[]>([]),
    [cursor, setCursor] = React.useState<string | null>(null),
    [loading, setLoading] = React.useState(false),
    [error, setError] = React.useState<string | null>(null),
    [chosen, setChosen] = React.useState<ConnectorCandidate | null>(null),
    [url, setUrl] = React.useState(''),
    [token, setToken] = React.useState(''),
    [added, setAdded] = React.useState<Connector | null>(null);
  const generation = React.useRef(0);
  const search = async (q: string, next?: string) => {
    const id = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await apiClient.searchConnectorRegistry(q, next);
      if (id === generation.current) {
        setEntries((prev) => (next ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      }
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : 'Could not load registry');
    } finally {
      if (id === generation.current) setLoading(false);
    }
  };
  React.useEffect(() => {
    setEntries([]);
    setCursor(null);
    generation.current++;
    const timer = setTimeout(() => void search(query.trim()), 250);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query]);
  const add = async (entry: ConnectorCandidate, serverUrl = entry.input.url, bearer?: string) => {
    const connector = await store.createConnector({
      ...entry.input,
      url: requireHttpUrl(serverUrl),
      ...(bearer ? { token: bearer } : {}),
    });
    setAdded(connector);
    setChosen(null);
  };
  return (
    <ScreenBody>
      <input
        className="screen-search"
        type="search"
        aria-label="Search MCP registry"
        placeholder="Search servers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <TaskError error={error || task.error} />
      {error ? (
        <ScreenButton onClick={() => void search(query.trim())}>Retry registry search</ScreenButton>
      ) : null}
      {added ? (
        <p role="status">
          {added.name} ·{' '}
          {added.status
            ? {
                connected: 'Connected',
                unreachable: 'Unreachable',
                needs_auth: 'Needs auth',
                needs_reauth: 'Needs reauth',
                error: 'Error',
              }[added.status]
            : 'Status unknown'}
        </p>
      ) : null}
      <Section title="MCP registry">
        <Card>
          {entries.map((entry) => {
            const installed = store.connectors.some((c) => c.url === entry.input.url);
            return (
              <div className="screen-row" key={`${entry.id}:${entry.input.url}`}>
                <span className="screen-row-copy">
                  <strong>{entry.input.name}</strong>
                  <span className="screen-detail">{entry.description}</span>
                </span>
                <ScreenButton
                  disabled={task.busy || installed}
                  onClick={() => {
                    if (entry.requiresConfiguration) {
                      setChosen(entry);
                      setUrl(entry.input.url);
                      setToken('');
                    } else void task.run(() => add(entry));
                  }}
                >
                  {installed ? 'Added' : entry.requiresConfiguration ? 'Configure' : 'Add'}
                </ScreenButton>
              </div>
            );
          })}
        </Card>
        {loading ? (
          <p role="status">Loading servers…</p>
        ) : !entries.length && !error ? (
          <p>No remote servers match your search.</p>
        ) : null}
        {cursor ? (
          <ScreenButton disabled={loading} onClick={() => void search(query.trim(), cursor)}>
            Load more
          </ScreenButton>
        ) : null}
      </Section>
      {chosen ? (
        <Section title={`Configure ${chosen.input.name}`}>
          <form
            className="screen-form"
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(() => add(chosen, url, token));
            }}
          >
            <Field label="Server URL">
              <input value={url} onChange={(e) => setUrl(e.target.value)} required type="url" />
            </Field>
            {chosen.headerNames.length ? (
              <p className="screen-detail">
                Required headers: {chosen.headerNames.join(', ')}. Bearer authorization is supported
                here; other custom headers require server-side configuration.
              </p>
            ) : null}
            <Field label="Bearer token">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <ScreenButton
              type="submit"
              disabled={
                task.busy ||
                /\{[^{}]+\}/.test(url) ||
                chosen.headerNames.some((n) => n.toLowerCase() !== 'authorization')
              }
            >
              Add server
            </ScreenButton>
            <ScreenButton onClick={() => setChosen(null)}>Cancel</ScreenButton>
          </form>
        </Section>
      ) : null}
      <p className="screen-footnote">
        From registry.modelcontextprotocol.io. Listed servers aren’t reviewed by Praxis; check a
        server before trusting it. Adding a server checks its connection.
      </p>
    </ScreenBody>
  );
}
