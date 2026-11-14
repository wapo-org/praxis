import styles from './App.module.css';
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChatScreen } from './components/chat/ChatScreen';
import { ConsentPopover } from './components/screens/ConsentPopover';
import type { SettingsSheet } from './components/screens/SettingsPage';
const SettingsPage = React.lazy(() =>
  import('./components/screens/SettingsPage').then((m) => ({
    default: m.SettingsPage,
  })),
);
import { SearchHost } from './components/search/SearchPalette';
const Sidebar = React.lazy(() =>
  import('./components/shell/Sidebar').then((m) => ({ default: m.Sidebar })),
);
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
    const onSearchKey = (event: KeyboardEvent) => {
      // ⌘K on macOS, Ctrl+K elsewhere, from anywhere (capture phase, so a focused field cannot swallow it);
      // pressing it again closes. Any other modifier is the browser's or the OS's, so it passes through.
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new Event('praxis:search-toggle'));
    };
    window.addEventListener('keydown', onSearchKey, true);
    const onKey = (event: KeyboardEvent) => {
      // New chat: Cmd/Ctrl+Shift+O, as in other chat apps.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        store.startNewConversation();
      }
      // The tray handles Escape itself (models → main → close); stay out
      // of the way when it already handled the key.
      if (event.key === 'Escape' && !event.defaultPrevented) store.setPlusTrayOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSearchKey, true);
    };
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
      <main className={styles.notFound}>
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
      <React.Suspense fallback={null}>
        <Sidebar devTools={!!lab} />
      </React.Suspense>
      <div className="praxis-page">
        {settingsSheet ? (
          <React.Suspense fallback={null}>
            <SettingsPage sheet={settingsSheet} onOpenGlassLab={lab} />
          </React.Suspense>
        ) : (
          <ChatScreen />
        )}
      </div>
      <ConsentPopover />
      <SearchHost />
    </div>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);
/** The search shortcut: exactly ⌘K on Apple platforms, exactly Ctrl+K elsewhere. */
export function isSearchShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>, mac = IS_MAC): boolean {
  if (event.isComposing || event.repeat || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== 'k' && event.code !== 'KeyK') return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
