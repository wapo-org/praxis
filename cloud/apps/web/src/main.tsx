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
