import React from 'react';
import { usePraxisStore } from '../../state/store.js';
import { SheetDialog } from './SheetDialog.js';

const loadHistory = () => import('./HistorySheet.js');
const loadSettings = () => import('./SettingsModal.js');
const loadConsent = () => import('./ConsentSheet.js');
const HistorySheet = React.lazy(() => loadHistory().then((m) => ({ default: m.HistorySheet })));
const SettingsModal = React.lazy(() => loadSettings().then((m) => ({ default: m.SettingsModal })));
const ConsentSheet = React.lazy(() => loadConsent().then((m) => ({ default: m.ConsentSheet })));

/** Fetch the sheets once the browser is idle, so the first open never waits on the network. */
function useIdlePreload() {
  React.useEffect(() => {
    const preload = () => {
      void loadHistory().catch(() => {});
      void loadSettings().catch(() => {});
      void loadConsent().catch(() => {});
    };
    if (typeof requestIdleCallback === 'undefined') {
      const timer = setTimeout(preload, 2000);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(preload, { timeout: 4000 });
    return () => cancelIdleCallback(handle);
  }, []);
}

export function SheetsRoot({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  const sheet = store.activeSheet;
  const dismiss = () => store.setActiveSheet(null);
  useIdlePreload();
  return (
    <>
      {sheet === 'history' ? (
        <SheetDialog label="Chats" onDismiss={dismiss}>
          <React.Suspense fallback={null}>
            <HistorySheet onSelect={dismiss} />
          </React.Suspense>
        </SheetDialog>
      ) : sheet ? (
        <SheetDialog label="Settings" size="settings" onDismiss={dismiss}>
          <React.Suspense fallback={null}>
            <SettingsModal sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
          </React.Suspense>
        </SheetDialog>
      ) : null}
      {store.pendingConsentPrompt ? (
        <React.Suspense fallback={null}>
          <ConsentSheet />
        </React.Suspense>
      ) : null}
    </>
  );
}
