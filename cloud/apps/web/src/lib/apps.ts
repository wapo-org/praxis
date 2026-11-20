import { COMPOSIO_APPS, COMPOSIO_META_TOOL_NAMES, type ComposioApp } from '@praxis/protocol';
import type { AppConnections, AppConnectionStatus } from '../hooks/useAppConnections';

/** What one app card shows: the connection row's status, or why there is none to show. */
export type AppState = 'loading' | 'unavailable' | 'disconnected' | AppConnectionStatus;

export function appState(connections: AppConnections, toolkit: string): AppState {
  if (connections.state === 'loading') return 'loading';
  if (connections.state === 'error') return 'unavailable';
  return connections.byToolkit.get(toolkit) ?? 'disconnected';
}

export function searchApps(query: string): readonly ComposioApp[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMPOSIO_APPS;
  return COMPOSIO_APPS.filter(app => `${app.name} ${app.description}`.toLowerCase().includes(needle));
}

export const APP_STATE_COPY: Record<AppState, string> = {
  loading: 'Checking…',
  unavailable: 'Status unavailable',
  disconnected: 'Not connected',
  pending: 'Waiting for sign-in',
  connected: 'Connected',
  failed: 'Needs reconnecting',
};

/** The connect button's verb; a connected app offers Disconnect instead. */
export function connectVerb(state: AppState): string {
  if (state === 'failed') return 'Reconnect';
  return state === 'pending' ? 'Continue connecting' : 'Connect';
}

const META_TOOLS: ReadonlySet<string> = new Set(Object.values(COMPOSIO_META_TOOL_NAMES));

/** Tool names and taint labels (underscores shown as spaces) of the Tool Router meta-tools read as "a connected app". */
export function friendlyToolLabel(nameOrLabel: string, appLabel: string): string {
  return META_TOOLS.has(nameOrLabel.replace(/ /g, '_')) ? appLabel : nameOrLabel;
}
