import React from 'react';
import ReactDOM from 'react-dom/client';
import { AccountGate } from './components/screens/AccountGate';
import { BrowserRouter, useNavigate } from 'react-router-dom';
const AuthenticatedApp = React.lazy(() => import('./AuthenticatedApp'));
import './styles/tokens.css';
import './styles/reading-fonts.css';
// Start the reading faces' Latin subsets at boot (dev and build alike), long before the first answer renders.
if (typeof document !== 'undefined' && document.fonts) {
  for (const face of ['400 15px "Noto Serif Variable"', 'italic 400 15px "Noto Serif Variable"', '650 20px "Noto Sans Variable"', '400 13px "Geist Mono Variable"']) {
    void document.fonts.load(face, 'a').catch(() => {});
  }
}
import './styles/theme.css';
import { syncSidebarLook } from './lib/sidebarPalette';

syncSidebarLook();

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  } else {
    // Never run the shell worker in dev: an earlier dev session's worker served cached CSS/JS forever,
    // mixing stale styles with fresh components (the owner's tall black composer and empty menu tops).
    // Remove it and its caches, then reload once so this page is no longer served by it.
    const controlled = !!navigator.serviceWorker.controller;
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .then(() => ('caches' in window ? caches.keys() : Promise.resolve([] as string[])))
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('praxis-')).map((k) => caches.delete(k))))
      .then(() => {
        if (controlled && !sessionStorage.getItem('praxis-sw-purged')) {
          sessionStorage.setItem('praxis-sw-purged', '1');
          window.location.reload();
        }
      })
      .catch(() => {});
  }
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
