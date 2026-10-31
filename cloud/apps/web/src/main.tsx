import React from 'react';
import ReactDOM from 'react-dom/client';
import { GlassRuntime } from '@praxis/glass';
import { PraxisStoreProvider } from './state/store';
import { AccountGate } from './components/screens/AccountGate';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { App } from './App';
import './styles/theme.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

function RoutedApp() {
  const navigate = useNavigate();
  return <AccountGate><PraxisStoreProvider onNavigate={navigate}><App /></PraxisStoreProvider></AccountGate>;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <GlassRuntime level="regular">
        <BrowserRouter><RoutedApp /></BrowserRouter>
      </GlassRuntime>
    </React.StrictMode>,
  );
}
