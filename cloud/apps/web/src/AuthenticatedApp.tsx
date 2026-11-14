import React from 'react';
import {useLocation} from 'react-router-dom';
import { App } from './App';
import { PraxisStoreProvider } from './state/store';
import type { NavigateFunction } from 'react-router-dom';
const StreamLabPage = import.meta.env.DEV ? React.lazy(() => import('./components/lab/StreamLabPage').then(m => ({default:m.StreamLabPage}))) : null;
const H2DesignLabPage = import.meta.env.DEV ? React.lazy(()=>import('./components/lab/H2DesignLabPage').then(m=>({default:m.H2DesignLabPage}))) : null;
export default function AuthenticatedApp({ onNavigate }: { onNavigate: NavigateFunction }) {
  const {pathname}=useLocation();
  if(import.meta.env.DEV && StreamLabPage && pathname==='/lab/stream') return <React.Suspense fallback={null}><StreamLabPage /></React.Suspense>;
  if(import.meta.env.DEV && H2DesignLabPage && pathname==='/lab/activity') return <React.Suspense fallback={null}><H2DesignLabPage /></React.Suspense>;
  return (
    <PraxisStoreProvider onNavigate={onNavigate}>
      <App />
    </PraxisStoreProvider>
  );
}
