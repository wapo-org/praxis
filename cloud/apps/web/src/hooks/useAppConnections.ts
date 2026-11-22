import React from 'react';
import { useQueries } from 'convex/react';
import { ComposioConnectionListSchema, type ComposioConnectionStatus } from '@praxis/protocol';
import { api } from '../../../../convex/_generated/api';

export type AppConnectionStatus = ComposioConnectionStatus;

export type AppConnections =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; byToolkit: ReadonlyMap<string, AppConnectionStatus> };

// `useQueries` re-subscribes when this object changes identity, so it lives at module scope.
const QUERIES = { connections: { query: api.composio.connections.list, args: {} } };

/** The signed-in user's Composio connections, kept live by Convex (another tab's connect shows here too). */
export function useAppConnections(): AppConnections {
  const result: unknown = useQueries(QUERIES).connections;
  return React.useMemo(() => connectionsFrom(result), [result]);
}

/** Fails closed: one malformed row makes the whole result unusable, so no card shows a state the server never sent. */
export function connectionsFrom(result: unknown): AppConnections {
  if (result === undefined) return { state: 'loading' };
  // A failed query arrives as a value, so the directory shows an error instead of unmounting the app.
  if (result instanceof Error) return { state: 'error' };
  const rows = ComposioConnectionListSchema.safeParse(result);
  if (!rows.success) {
    console.warn('App connections had an unexpected shape', rows.error.issues.length);
    return { state: 'error' };
  }
  const byToolkit = new Map(rows.data.map(({ toolkit, status }) => [toolkit, status] as const));
  return { state: 'ready', byToolkit };
}
