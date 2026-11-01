import { GlassSurface } from '@praxis/glass';
import { usePraxisStore, type ActiveSheet } from '../../state/store.js';
import {
  ConnectorAddURL,
  ConnectorPasteConfig,
  ConnectorRegistry,
  ConnectorsScreen,
} from './ConnectorsScreen.js';
import { ConsentSheet, ConsentsScreen } from './ConsentSheet.js';
import { HistorySheet } from './HistorySheet.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { ScreenHeader, SheetDialog } from './ScreenUI.js';
import { ProviderEditor, SettingsSheet } from './SettingsSheet.js';
import { SkillBrowser, SkillImport, SkillsScreen } from './SkillsScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';

const SHEETS: Record<NonNullable<ActiveSheet>, { title: string; parent?: ActiveSheet }> = {
  history: { title: 'Chats' },
  settings: { title: 'Settings' },
  providers: { title: 'Model providers', parent: 'settings' },
  'provider-editor': { title: 'Provider', parent: 'settings' },
  connectors: { title: 'Connectors', parent: 'settings' },
  'connector-add-url': { title: 'Add by URL', parent: 'connectors' },
  'connector-paste-config': { title: 'Paste a config', parent: 'connectors' },
  'connector-registry': { title: 'MCP registry', parent: 'connectors' },
  skills: { title: 'Skills', parent: 'settings' },
  'skill-import': { title: 'Import skill', parent: 'skills' },
  'skill-browser': { title: 'Browse skills', parent: 'skills' },
  'image-reader': { title: 'Image reading model', parent: 'settings' },
  'voice-settings': { title: 'Voice input', parent: 'settings' },
  consents: { title: 'Data consents', parent: 'settings' },
};

function SheetContent({
  sheet,
  onOpenGlassLab,
}: {
  sheet: NonNullable<ActiveSheet>;
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  switch (sheet) {
    case 'history':
      return <HistorySheet onSelect={() => store.setActiveSheet(null)} />;
    case 'settings':
    case 'providers':
      return <SettingsSheet onOpenGlassLab={onOpenGlassLab} />;
    case 'provider-editor':
      if (store.editingProviderId && !store.hydrated) return <p role="status">Loading provider…</p>;
      if (store.editingProviderId && !store.providers.some((p) => p.id === store.editingProviderId))
        return <p role="alert">Provider not found.</p>;
      return <ProviderEditor key={store.editingProviderId ?? 'new-provider'} />;
    case 'connectors':
      return <ConnectorsScreen />;
    case 'connector-add-url':
      return <ConnectorAddURL />;
    case 'connector-paste-config':
      return <ConnectorPasteConfig />;
    case 'connector-registry':
      return <ConnectorRegistry />;
    case 'skills':
      return <SkillsScreen />;
    case 'skill-import':
      return <SkillImport />;
    case 'skill-browser':
      return <SkillBrowser />;
    case 'image-reader':
      return <ImageReaderScreen />;
    case 'voice-settings':
      return <VoiceSettingsScreen />;
    case 'consents':
      return <ConsentsScreen />;
  }
}

export function DesktopHistorySidebar() {
  const store = usePraxisStore();
  if (!store.desktopSidebarOpen) return null;
  return (
    <aside className="screen-sidebar" aria-label="Conversation history">
      <GlassSurface shape="free" radius={0} material="thin">
        <div className="screen-shell">
          <HistorySheet />
        </div>
      </GlassSurface>
    </aside>
  );
}

export function SheetsRoot({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  const sheet = store.activeSheet;
  const config = sheet ? SHEETS[sheet] : null;
  return (
    <>
      <DesktopHistorySidebar />
      {sheet && config ? (
        <SheetDialog label={config.title} onDismiss={() => store.setActiveSheet(null)}>
          {sheet !== 'history' && (
            <ScreenHeader
              trailing={
                sheet === 'provider-editor' ? (
                  <button className="screen-text-button" type="submit" form="provider-editor-form">
                    Save
                  </button>
                ) : undefined
              }
              title={config.title}
              onBack={
                config.parent ? () => store.setActiveSheet(config.parent ?? 'settings') : undefined
              }
              onClose={() => store.setActiveSheet(null)}
            />
          )}
          <SheetContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
        </SheetDialog>
      ) : null}
      {store.pendingConsentPrompt ? <ConsentSheet /> : null}
    </>
  );
}
