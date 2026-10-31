import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChatScreen } from './components/chat/ChatScreen';
import { SheetsRoot } from './components/screens/SheetsRoot';
import { GlassLabPage } from './components/lab/GlassLabPage';
import { usePraxisStore } from './state/store';
import { parseRoute } from './lib/navigation';

export function App() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const store = usePraxisStore();
  const restore = React.useRef(store.restoreRoute); restore.current = store.restoreRoute;
  React.useEffect(() => {
    const route = parseRoute(pathname);
    restore.current(route.chatId ?? null, route.sheet, route.providerId);
  }, [pathname]);
  React.useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const apply = () => store.setDesktopSidebarOpen(media.matches);
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); store.setActiveSheet('history');
        requestAnimationFrame(() => (document.querySelector<HTMLInputElement>('[role="dialog"] [aria-label="Search conversations"]') ?? document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]'))?.focus());
      }
      if (event.key === 'Escape') {
        store.setPlusTrayOpen(false);
        if (store.activeSheet) store.setActiveSheet(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const lab = import.meta.env.DEV ? () => navigate('/lab/glass') : undefined;
  if (import.meta.env.DEV && pathname === '/lab/glass') return <GlassLabPage onNavigateBack={() => navigate('/')} />;
  if (!parseRoute(pathname).valid) return <main className="account-screen"><div><h1>Page not found</h1><button onClick={() => navigate('/')}>New chat</button></div></main>;
  return <div data-testid="praxis-app-root" className="praxis-app-root">
    <ChatScreen onOpenGlassLab={lab} /><SheetsRoot onOpenGlassLab={lab} />
  </div>;
}
