import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChatScreen } from './components/chat/ChatScreen';
import { Sidebar } from './components/shell/Sidebar';
import { SheetsRoot } from './components/screens/SheetsRoot';
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
        const sidebarSearch = store.desktopSidebarOpen
          ? document.querySelector<HTMLInputElement>('[data-testid="app-sidebar"] [aria-label="Search conversations"]')
          : null;
        if (sidebarSearch) return sidebarSearch.focus();
        store.setActiveSheet('history');
        requestAnimationFrame(() =>
          (
            document.querySelector<HTMLInputElement>(
              '[role="dialog"] [aria-label="Search conversations"]',
            ) ?? document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')
          )?.focus(),
        );
      }
      if (event.key === 'Escape') {
        store.setPlusTrayOpen(false);
        if (store.activeSheet) store.setActiveSheet(null);
      }
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
  return (
    <div data-testid="praxis-app-root" className="praxis-app-root">
      <Sidebar />
      <ChatScreen />
      <SheetsRoot onOpenGlassLab={lab} />
    </div>
  );
}
