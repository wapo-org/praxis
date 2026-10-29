import React from 'react';
import { ChatScreen } from './components/chat/ChatScreen';
import { SheetsRoot } from './components/screens/SheetsRoot';
import { GlassLabPage } from './components/lab/GlassLabPage';

export function App() {
  const [route, setRoute] = React.useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname + window.location.hash : '/',
  );

  React.useEffect(() => {
    const onPop = () => setRoute(window.location.pathname + window.location.hash);
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);

  if (route.startsWith('/lab/glass') || route.includes('#glass-lab')) {
    return (
      <GlassLabPage
        onNavigateBack={() => {
          window.history.pushState({}, '', '/');
          setRoute('/');
        }}
      />
    );
  }

  return (
    <div
      data-testid="praxis-app-root"
      style={{
        position: 'relative',
        width: '100vw',
        height: '100dvh',
        backgroundColor: 'var(--paper-canvas)',
        color: 'var(--paper-ink)',
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      <ChatScreen
        onOpenGlassLab={() => {
          window.history.pushState({}, '', '/lab/glass');
          setRoute('/lab/glass');
        }}
      />
      <SheetsRoot
        onOpenGlassLab={() => {
          window.history.pushState({}, '', '/lab/glass');
          setRoute('/lab/glass');
        }}
      />
    </div>
  );
}
