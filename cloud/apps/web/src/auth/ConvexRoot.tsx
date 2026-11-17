import React from 'react';
import { ConvexReactClient } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { api } from '../../../../convex/_generated/api';
import { AUTH_COPY } from './constants';
import { AuthFrame } from './EmailScreens';

const url = import.meta.env.VITE_CONVEX_URL;
const client = url ? new ConvexReactClient(String(url)) : null;
export function ConvexRoot({ children }: { children: React.ReactNode }) {
  if (!client) return <AuthFrame><p role="alert">{AUTH_COPY.unavailable}</p></AuthFrame>;
  return <ConvexAuthProvider client={client} api={api.auth}>{children}</ConvexAuthProvider>;
}
