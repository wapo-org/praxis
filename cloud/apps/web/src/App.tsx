import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChatScreen } from './components/chat/ChatScreen';
import { ConsentPopover } from './components/screens/ConsentPopover';
import { SettingsPage, type SettingsSheet } from './components/screens/SettingsPage';
import { Sidebar } from './components/shell/Sidebar';
import { parseRoute } from './lib/navigation';
import { usePraxisStore } from './state/store';
const GlassLabPage = import.meta.env.DEV
  ? React.lazy(() =>
      import('./components/lab/GlassLabPage').then((m) => ({
        default: m.GlassLabPage,
      })),
    )
  : null;

export function App() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const store = usePraxisStore();
  const restore = React.useRef(store.restoreRoute);
  restore.current = store.restoreRoute;
  React.useEffect(() => {
    const route = parseRoute(pathname);
    restore.current(route.chatId ?? null, route.sheet, route.providerId);
  }, [pathname]);
  React.useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const apply = () => store.setDesktopSidebarOpen(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // History lives in the floating sidebar on every screen size.
        store.setDesktopSidebarOpen(true);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>('[data-testid="app-sidebar"] [aria-label="Search conversations"]')
            ?.focus(),
        );
      }
      if (event.key === 'Escape') store.setPlusTrayOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const lab = import.meta.env.DEV ? () => navigate('/lab') : undefined;
  if (import.meta.env.DEV && GlassLabPage && (pathname === '/lab' || pathname === '/lab/glass'))
    return (
      <React.Suspense fallback={<p>Loading lab…</p>}>
        <GlassLabPage onNavigateBack={() => navigate('/')} />
      </React.Suspense>
    );
  if (!parseRoute(pathname).valid)
    return (
      <main className="account-screen">
        <div>
          <h1>Page not found</h1>
          <button onClick={() => navigate('/')}>New chat</button>
        </div>
      </main>
    );
  const sheet = parseRoute(pathname).sheet;
  // Settings is a routed page, not a modal: there are no sheets or scrims.
  const settingsSheet: SettingsSheet | null = sheet && sheet !== 'history' ? sheet : null;
  return (
    <div data-testid="praxis-app-root" className="praxis-app-root">
      <Sidebar />
      {settingsSheet ? <SettingsPage sheet={settingsSheet} onOpenGlassLab={lab} /> : <ChatScreen />}
      <ConsentPopover />
    </div>
  );
}
