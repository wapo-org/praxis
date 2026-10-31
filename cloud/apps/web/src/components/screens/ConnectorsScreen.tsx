import React from 'react';
import { apiClient } from '../../lib/api.js';
import { ExternalLink, FileJson, Grid2X2, Link, RefreshCw, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  Field,
  hostLabel,
  NavRow,
  requireHttpUrl,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';

interface ConnectorInput {
  name: string;
  url: string;
  transport?: 'streamableHttp' | 'sse';
  token?: string;
}

/** Parse the complete document before creating anything, so invalid entries never partially import. */
export function parseConnectorConfig(source: string): ConnectorInput[] {
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = requireHttpUrl(trimmed);
    return [{ name: hostLabel(url), url, transport: 'streamableHttp' }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Paste a server URL or valid JSON with an mcpServers object.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('mcpServers' in parsed) ||
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== 'object' ||
    Array.isArray(parsed.mcpServers)
  ) {
    throw new Error('The config must contain an mcpServers object.');
  }
  const entries = Object.entries(parsed.mcpServers);
  if (!entries.length) throw new Error('The config contains no servers.');
  return entries.map(([name, value]) => {
    if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string')
      throw new Error(
        `${name}: only remote servers with an HTTP or HTTPS URL are supported. Local commands cannot run in the browser.`,
      );
    const config = value as Record<string, unknown>;
    if (
      config.transport !== undefined &&
      config.transport !== 'sse' &&
      config.transport !== 'streamableHttp' &&
      config.transport !== 'http'
    )
      throw new Error(`${name}: unsupported transport.`);
    if (
      config.type !== undefined &&
      config.type !== 'sse' &&
      config.type !== 'http' &&
      config.type !== 'streamableHttp'
    )
      throw new Error(`${name}: unsupported server type.`);
    let token: string | undefined;
    if (config.headers !== undefined) {
      if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers))
        throw new Error(`${name}: headers must be an object.`);
      for (const [header, secret] of Object.entries(config.headers)) {
        if (
          header.toLowerCase() !== 'authorization' ||
          typeof secret !== 'string' ||
          !/^Bearer\s+\S+/i.test(secret)
        )
          throw new Error(
            `${name}: only an Authorization: Bearer token header is supported by this connector API.`,
          );
        token = secret.replace(/^Bearer\s+/i, '');
      }
    }
    if (!name.trim() || name.length > 100)
      throw new Error('Server names must contain 1–100 characters.');
    return {
      name: name.trim(),
      url: requireHttpUrl(value.url),
      transport: config.transport === 'sse' || config.type === 'sse' ? 'sse' : 'streamableHttp',
      token,
    };
  });
}

export function ConnectorsScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const refresh = () => {
      void task.run(() => store.refreshAll());
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [store.refreshAll]);
  const signIn = (id: string) => {
    // Open during the click gesture; opening after the request is blocked by browsers.
    const popup = window.open('about:blank', '_blank', 'popup,width=560,height=720');
    if (popup) popup.opener = null;
    void task.run(async () => {
      try {
        if (!popup) throw new Error('Allow pop-ups for Praxis, then try signing in again.');
        const authorization = await apiClient.startConnectorOAuth(id, window.location.href);
        popup.location.replace(requireHttpUrl(authorization.url));
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  };
  return (
    <ScreenBody>
      <TaskError error={task.error} />
      <Section title="Installed">
        {store.connectors.length ? (
          <Card>
            {store.connectors.map((connector) => {
              const open = expanded.has(connector.id);
              const tools = store.connectorTools[connector.id];
              const status = connector.status
                ? ({
                    connected: 'Connected',
                    unreachable: 'Unreachable',
                    needs_auth: 'Needs auth',
                    needs_reauth: 'Needs reauth',
                    error: 'Error',
                  }[connector.status] ?? 'Status unknown')
                : 'Status unknown';
              return (
                <div className="screen-list-item" key={connector.id}>
                  <button
                    type="button"
                    className="screen-row screen-nav-row"
                    aria-expanded={open}
                    aria-controls={`tools-${connector.id}`}
                    onClick={() => {
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(connector.id)) next.delete(connector.id);
                        else next.add(connector.id);
                        return next;
                      });
                      if (!open) void task.run(() => store.loadConnectorTools(connector.id));
                    }}
                  >
                    <span className="screen-avatar">
                      {connector.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="screen-row-copy">
                      <strong>{connector.name}</strong>
                      <span className="screen-detail">{hostLabel(connector.url)}</span>
                      <span
                        className={`screen-detail ${status === 'Connected' ? 'screen-success' : ''}`}
                      >
                        {status} · {tools?.length ?? connector.toolCount ?? 0} tools
                      </span>
                    </span>
                    {connector.hasNewTools ? <span className="screen-badge">New tool</span> : null}
                    <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                  </button>
                  {open ? (
                    <div className="screen-list-detail" id={`tools-${connector.id}`}>
                      <Toggle
                        label={`Enable ${connector.name}`}
                        checked={connector.enabled}
                        disabled={task.busy}
                        onChange={(enabled) => {
                          void task.run(() => store.updateConnector(connector.id, { enabled }));
                        }}
                      />
                      {connector.error ? <p className="screen-error">{connector.error}</p> : null}
                      <div className="screen-actions">
                        <ScreenButton
                          disabled={task.busy}
                          onClick={() => {
                            void task.run(async () => {
                              await store.loadConnectorTools(connector.id);
                              await store.refreshAll();
                            });
                          }}
                        >
                          <RefreshCw size={14} />
                          Refresh tools
                        </ScreenButton>
                        {connector.status === 'needs_auth' ||
                        connector.status === 'needs_reauth' ||
                        connector.authStatus === 'required' ? (
                          <ScreenButton disabled={task.busy} onClick={() => signIn(connector.id)}>
                            <ExternalLink size={14} />
                            Sign in
                          </ScreenButton>
                        ) : null}
                      </div>
                      {tools ? (
                        tools.length ? (
                          tools.map((tool) => (
                            <Toggle
                              key={tool.name}
                              label={tool.name}
                              detail={tool.description}
                              checked={!connector.disabledTools.includes(tool.name)}
                              disabled={task.busy || !connector.enabled}
                              onChange={(enabled) => {
                                void task.run(() =>
                                  store.setConnectorToolEnabled(connector.id, tool.name, enabled),
                                );
                              }}
                            />
                          ))
                        ) : (
                          <p className="screen-footnote">No tools returned by this connector.</p>
                        )
                      ) : (
                        <p className="screen-footnote">
                          {task.busy ? 'Loading tools…' : 'Refresh tools to try again.'}
                        </p>
                      )}
                      <ScreenButton
                        tone="destructive"
                        disabled={task.busy}
                        onClick={() => {
                          void task.run(() => store.removeConnector(connector.id));
                        }}
                      >
                        <Trash2 size={15} />
                        Delete connector
                      </ScreenButton>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Card>
        ) : (
          <p className="screen-empty">
            No connectors yet. Add one below to give the agent tools like your issue tracker or
            docs.
          </p>
        )}
      </Section>
      <Section title="Add a connector">
        <Card>
          <NavRow
            icon={<Link size={17} />}
            title="Add by URL"
            detail="A server address, with a token if it needs one"
            onClick={() => store.setActiveSheet('connector-add-url')}
          />
          <NavRow
            icon={<FileJson size={17} />}
            title="Paste a config"
            detail="mcp.json or claude_desktop_config.json"
            onClick={() => store.setActiveSheet('connector-paste-config')}
          />
          <NavRow
            icon={<Grid2X2 size={17} />}
            title="Browse the MCP registry"
            detail="Public servers you can reach by URL"
            onClick={() => store.setActiveSheet('connector-registry')}
          />
        </Card>
      </Section>
      <p className="screen-footnote">
        Connectors are remote MCP servers. Servers that run local programs are not supported.
      </p>
    </ScreenBody>
  );
}

export function ConnectorAddURL() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [transport, setTransport] = React.useState<'streamableHttp' | 'sse'>('streamableHttp');
  return (
    <ScreenBody>
      <form
        className="screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await store.createConnector({
              name: name.trim(),
              url: requireHttpUrl(url),
              transport,
              ...(token ? { token } : {}),
            });
            store.setActiveSheet('connectors');
          });
        }}
      >
        <TaskError error={task.error} />
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My connector"
            required
            maxLength={100}
          />
        </Field>
        <Field label="MCP Server URL">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
            required
            type="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="Transport">
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value as typeof transport)}
          >
            <option value="streamableHttp">Streamable HTTP</option>
            <option value="sse">Server-sent events (SSE)</option>
          </select>
        </Field>
        <Field
          label="Bearer token (optional)"
          hint="Leave blank for servers that use OAuth or do not need a token."
        >
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>
        <ScreenButton
          type="submit"
          tone="primary"
          disabled={task.busy || !name.trim() || !url.trim()}
        >
          {task.busy ? 'Adding…' : 'Add connector'}
        </ScreenButton>
      </form>
    </ScreenBody>
  );
}

export function ConnectorPasteConfig() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [source, setSource] = React.useState('');
  const [completed, setCompleted] = React.useState<string[]>([]);
  const imported = React.useRef(new Set<string>());
  return (
    <ScreenBody>
      <form
        className="screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const inputs = parseConnectorConfig(source);
            for (const input of inputs) {
              const key = `${input.name}\n${input.url}`;
              if (imported.current.has(key)) continue;
              await store.createConnector(input);
              imported.current.add(key);
              setCompleted((previous) => [...previous, input.name]);
            }
            store.setActiveSheet('connectors');
          });
        }}
      >
        <p className="screen-intro">
          Paste a remote MCP server URL or a config with an mcpServers object. Bearer authorization
          headers are supported.
        </p>
        <TaskError error={task.error} />
        {completed.length ? (
          <p className="screen-success" role="status">
            Added: {completed.join(', ')}. Retry to finish importing the remaining servers.
          </p>
        ) : null}
        <Field label="Server config">
          <textarea
            className="screen-mono"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            rows={14}
            required
            spellCheck={false}
            placeholder={
              '{\n  "mcpServers": {\n    "My server": { "url": "https://example.com/mcp" }\n  }\n}'
            }
          />
        </Field>
        <ScreenButton type="submit" tone="primary" disabled={task.busy || !source.trim()}>
          {task.busy ? 'Importing…' : 'Add connectors'}
        </ScreenButton>
      </form>
    </ScreenBody>
  );
}

// Public endpoints documented by their maintainers:
// https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
// https://linear.app/docs/mcp
// https://mcp.sentry.dev/
const CURATED_SERVERS = [
  {
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    description: 'Repositories, issues, and pull requests. Requires sign-in.',
  },
  {
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    description: 'Issues, projects, and team workflows. Requires sign-in.',
  },
  {
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    description: 'Explore application errors and debugging context. Requires sign-in.',
  },
];

export function ConnectorRegistry() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const entries = CURATED_SERVERS.filter((server) =>
    `${server.name} ${server.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <ScreenBody>
      <input
        className="screen-search"
        type="search"
        aria-label="Search MCP registry"
        placeholder="Search servers…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <TaskError error={task.error} />
      <Section title="Curated remote servers">
        <Card>
          {entries.map((server) => {
            const installed = store.connectors.some(
              (connector) => connector.url.replace(/\/$/, '') === server.url.replace(/\/$/, ''),
            );
            return (
              <div className="screen-row" key={server.url}>
                <span className="screen-avatar">{server.name[0]}</span>
                <span className="screen-row-copy">
                  <strong>{server.name}</strong>
                  <span className="screen-detail">{server.description}</span>
                </span>
                <ScreenButton
                  disabled={installed || task.busy}
                  onClick={() => {
                    void task.run(() =>
                      store.createConnector({
                        name: server.name,
                        url: server.url,
                      }),
                    );
                  }}
                >
                  {installed ? 'Added' : 'Add'}
                </ScreenButton>
              </div>
            );
          })}
        </Card>
        {!entries.length ? <p className="screen-empty">No servers match your search.</p> : null}
      </Section>
      <p className="screen-footnote">
        After adding a server, expand its connector to review tools and sign in if required.
      </p>
    </ScreenBody>
  );
}
