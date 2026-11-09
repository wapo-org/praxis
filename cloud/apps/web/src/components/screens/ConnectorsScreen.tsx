import React from 'react';
import { apiClient } from '../../lib/api.js';
import { ExternalLink, FileJson, Grid2X2, Link, RefreshCw, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import { Card, Field, hostLabel, NavRow, requireHttpUrl, ScreenBody, ScreenButton, Section, TaskError, Toggle, useScreenTask } from './ScreenUI.js';
import styles from './Screen.module.css';

export { ConnectorAddURL, ConnectorPasteConfig, parseConnectorConfig } from './ConnectorForms';
export { ConnectorRegistry } from './ConnectorRegistry';

export function ConnectorsScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [keys,setKeys]=React.useState<Record<string,string>>({});
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
                    needs_auth: ['builtin-e2b','builtin-browserbase'].includes(connector.id) ? 'Add an API key to connect' : 'Sign in to connect',
                    needs_reauth: 'Sign in again',
                    error: 'Error',
                  }[connector.status] ?? 'Status unknown')
                : connector.enabled ? 'Ready to connect' : 'Disabled';
              return (
                <div className={styles.listItem} key={connector.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${styles.navRow}`}
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
                    <span className={styles.avatar}>
                      {connector.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.rowCopy}>
                      <strong>{connector.name}</strong>
                      <span className={styles.detail}>{hostLabel(connector.url)}</span>
                      <span
                        className={`${styles.detail} ${status === 'Connected' ? styles.success : ''}`}
                      >
                        {status} · {tools?.length ?? connector.toolCount ?? 0} tools
                      </span>
                    </span>
                    {connector.hasNewTools ? <span className={styles.badge}>New tool</span> : null}
                    <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                  </button>
                  {open ? (
                    <div className={styles.listDetail} id={`tools-${connector.id}`}>
                      <Toggle
                        label={`Enable ${connector.name}`}
                        checked={connector.enabled}
                        disabled={task.busy}
                        onChange={(enabled) => {
                          void task.run(() => store.updateConnector(connector.id, { enabled }));
                        }}
                      />
                      {connector.error || connector.statusCode ? <p className={styles.error}>{connectorIssue(connector.error ?? connector.statusCode!)}</p> : null}
                      {connector.id.startsWith('builtin-') ? <Field label={`${connector.name} API key`} hint={connector.id==='builtin-exa'||connector.id==='builtin-firecrawl'?'Optional. Leave blank for keyless access.':'Stored securely. Leave blank to keep the saved key.'}><input type="password" autoComplete="new-password" value={keys[connector.id]??''} onChange={e=>setKeys(prev=>({...prev,[connector.id]:e.target.value}))}/><ScreenButton disabled={task.busy||!keys[connector.id]} onClick={()=>{void task.run(async()=>{await store.updateConnector(connector.id,{token:keys[connector.id]});setKeys(prev=>({...prev,[connector.id]:''}));});}}>Save key</ScreenButton></Field> : null}
                      <div className={styles.actions}>
                        <ScreenButton
                          disabled={task.busy}
                          onClick={() => {
                            void task.run(async () => {
                              await store.loadConnectorTools(connector.id);
                              await store.refreshAll();
                            });
                          }}
                        >
                          <RefreshCw size={16} />
                          Refresh tools
                        </ScreenButton>
                        {connector.id === 'builtin-firecrawl' || (!['builtin-e2b','builtin-browserbase'].includes(connector.id) && (connector.status === 'needs_auth' ||
                        connector.status === 'needs_reauth' ||
                        connector.authStatus === 'required')) ? (
                          <ScreenButton disabled={task.busy} onClick={() => signIn(connector.id)}>
                            <ExternalLink size={16} />
                            Sign in
                          </ScreenButton>
                        ) : null}
                      </div>
                      {tools ? (
                        tools.length ? (
                          tools.map((tool) => (
                            <Toggle
                              key={tool.name}
                              label={tool.originalName ?? tool.name}
                              detail={tool.description}
                              checked={!connector.disabledTools.includes(tool.originalName ?? tool.name)}
                              disabled={task.busy}
                              onChange={(enabled) => {
                                void task.run(() =>
                                  store.setConnectorToolEnabled(connector.id, tool.name, enabled),
                                );
                              }}
                            />
                          ))
                        ) : (
                          <p className={styles.footnote}>No tools returned by this connector.</p>
                        )
                      ) : (
                        <p className={styles.footnote}>
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
                        <Trash2 size={16} />
                        Delete connector
                      </ScreenButton>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Card>
        ) : (
          <p className={styles.empty}>
            No connectors yet. Add one below to give the agent tools like your issue tracker or
            docs.
          </p>
        )}
      </Section>
      <Section title="Add a connector">
        <Card>
          <NavRow
            icon={<Link size={18} />}
            title="Add by URL"
            detail="A server address, with a token if it needs one"
            onClick={() => store.setActiveSheet('connector-add-url')}
          />
          <NavRow
            icon={<FileJson size={18} />}
            title="Paste a config"
            detail="mcp.json or claude_desktop_config.json"
            onClick={() => store.setActiveSheet('connector-paste-config')}
          />
          <NavRow
            icon={<Grid2X2 size={18} />}
            title="Browse the MCP registry"
            detail="Public servers you can reach by URL"
            onClick={() => store.setActiveSheet('connector-registry')}
          />
        </Card>
      </Section>
      <p className={styles.footnote}>
        Connectors are remote MCP servers. Servers that run local programs are not supported.
      </p>
    </ScreenBody>
  );
}

export function connectorIssue(code:string):string {
 const messages:Record<string,string>={needs_reauth:'Your sign-in has expired. Sign in again to reconnect.',authorization_required:'Sign in or add an API key to connect.',consent_required:'Allow data sharing in Data consents or when the chat asks.',mcp_unreachable:'This service cannot be reached. Try again shortly.',probe_timeout:'The service took too long to respond. Try again.',mcp_failed:'The service could not complete the request. Refresh tools to try again.',internal_error:'The connection could not be checked. Try again.',invalid_url:'Check the connector address.',unsafe_url:'This connector address is not supported.',connector_disabled:'Enable this connector to use its tools.',invalid_return_url:'This app address is not allowed for sign-in.',encryption_unconfigured:'Secure key storage is unavailable. Contact your administrator.'};
 return messages[code] ?? 'This connector needs attention. Refresh tools or sign in again.';
}
