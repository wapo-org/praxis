import React from 'react';
import ReactDOM from 'react-dom/client';
import { AccountGate } from './components/screens/AccountGate';
import { BrowserRouter, useNavigate } from 'react-router-dom';
const AuthenticatedApp = React.lazy(() => import('./AuthenticatedApp'));
import './styles/tokens.css';
import './styles/theme.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

function RoutedApp() {
  const navigate = useNavigate();
  return (
    <AccountGate>
      <React.Suspense fallback={null}>
        <AuthenticatedApp onNavigate={navigate} />
      </React.Suspense>
    </AccountGate>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BrowserRouter>
        <RoutedApp />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
