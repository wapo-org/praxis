import React from 'react';
import { GlassSurface } from '@praxis/glass';
import { usePraxisStore, type ActiveSheet } from '../../state/store.js';
import { HistorySheet } from './HistorySheet.js';
import { ProviderEditor, SettingsSheet } from './SettingsSheet.js';
import {
  ConnectorAddURL,
  ConnectorPasteConfig,
  ConnectorRegistry,
  ConnectorsScreen,
} from './ConnectorsScreen.js';
import { SkillBrowser, SkillImport, SkillsScreen } from './SkillsScreen.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';
import { ConsentSheet, ConsentsScreen } from './ConsentSheet.js';
import { ScreenHeader, SheetDialog } from './ScreenUI.js';

const SHEETS: Record<
  NonNullable<ActiveSheet>,
  { title: string; parent?: ActiveSheet }
> = {
  history: { title: 'History' },
  settings: { title: 'Settings' },
  providers: { title: 'Providers', parent: 'settings' },
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
          <ScreenHeader
            title="History"
            onClose={() => store.setDesktopSidebarOpen(false)}
          />
          <HistorySheet />
        </div>
      </GlassSurface>
    </aside>
  );
}

export function SheetsRoot({
  onOpenGlassLab,
}: {
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  const sheet = store.activeSheet;
  const config = sheet ? SHEETS[sheet] : null;
  return (
    <>
      <DesktopHistorySidebar />
      {sheet && config ? (
        <SheetDialog
          label={config.title}
          onDismiss={() => store.setActiveSheet(null)}
        >
          <ScreenHeader
            title={config.title}
            onBack={
              config.parent
                ? () => store.setActiveSheet(config.parent ?? 'settings')
                : undefined
            }
            onClose={() => store.setActiveSheet(null)}
          />
          <SheetContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
        </SheetDialog>
      ) : null}
      {store.pendingConsentPrompt ? <ConsentSheet /> : null}
    </>
  );
}
