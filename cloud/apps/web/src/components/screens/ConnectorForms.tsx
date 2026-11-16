import React from 'react';
import { usePraxisStore } from '../../state/store.js';
import { Field, hostLabel, requireHttpUrl, ScreenBody, Select, ScreenButton, TaskError, useScreenTask } from './ScreenUI.js';
import styles from './Screen.module.css';

interface ConnectorInput {
  name: string;
  url: string;
  transport?: 'streamableHttp' | 'sse';
  token?: string;
}

/** Validate whole document first to prevent partial imports. */
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
        className={styles.form}
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
          <Select
            value={transport}
            onChange={(event) => setTransport(event.target.value as typeof transport)}
          >
            <option value="streamableHttp">Streamable HTTP</option>
            <option value="sse">Server-sent events (SSE)</option>
          </Select>
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
        className={styles.form}
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
        <p className={styles.intro}>
          Paste a remote MCP server URL or a config with an mcpServers object. Bearer authorization
          headers are supported.
        </p>
        <TaskError error={task.error} />
        {completed.length ? (
          <p className={styles.success} role="status">
            Added: {completed.join(', ')}. Retry to finish importing the remaining servers.
          </p>
        ) : null}
        <Field label="Server config">
          <textarea
            className={styles.mono}
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
