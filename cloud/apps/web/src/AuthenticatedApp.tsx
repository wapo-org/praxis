import React from 'react';
import {useLocation} from 'react-router-dom';
import { App } from './App';
import { PraxisStoreProvider } from './state/store';
import type { NavigateFunction } from 'react-router-dom';
const StreamLabPage = import.meta.env.DEV ? React.lazy(() => import('./components/lab/StreamLabPage').then(m => ({default:m.StreamLabPage}))) : null;
export default function AuthenticatedApp({ onNavigate }: { onNavigate: NavigateFunction }) {
  const {pathname}=useLocation();
  if(import.meta.env.DEV && StreamLabPage && pathname==='/lab/stream') return <React.Suspense fallback={null}><StreamLabPage /></React.Suspense>;
  return (
    <PraxisStoreProvider onNavigate={onNavigate}>
      <App />
    </PraxisStoreProvider>
  );
}
