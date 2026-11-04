import { usePraxisStore } from '../../state/store.js';
import { ConsentSheet } from './ConsentSheet.js';
import { HistorySheet } from './HistorySheet.js';
import { ScreenHeader, SheetDialog } from './ScreenUI.js';
import { SettingsModal } from './SettingsModal.js';

export function SheetsRoot({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  const sheet = store.activeSheet;
  const dismiss = () => store.setActiveSheet(null);
  return (
    <>
      {sheet === 'history' ? (
        <SheetDialog label="Chats" onDismiss={dismiss}>
          <HistorySheet onSelect={dismiss} />
        </SheetDialog>
      ) : sheet ? (
        <SheetDialog label="Settings" size="settings" onDismiss={dismiss}>
          <SettingsModal sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
        </SheetDialog>
      ) : null}
      {store.pendingConsentPrompt ? <ConsentSheet /> : null}
    </>
  );
}
