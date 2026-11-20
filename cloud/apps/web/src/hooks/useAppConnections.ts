import React from 'react';
import { useQueries } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Doc } from '../../../../convex/_generated/dataModel';

type ConnectionRows = Doc<'connections'>[];
export type AppConnectionStatus = Doc<'connections'>['status'];

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

function connectionsFrom(result: unknown): AppConnections {
  if (result === undefined) return { state: 'loading' };
  // A failed query arrives as a value, so the directory shows an error instead of unmounting the app.
  if (result instanceof Error || !Array.isArray(result)) return { state: 'error' };
  const byToolkit = new Map<string, AppConnectionStatus>();
  for (const row of result as ConnectionRows) {
    byToolkit.set(row.toolkit, row.status);
  }
  return { state: 'ready', byToolkit };
}
