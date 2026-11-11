import {SavedValues} from './SavedSecrets';
import { GlassIconButton, PANEL } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { PanelLeft } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import { useContentShift } from '../shell/useContentShift';
import {
  ConnectorAddURL,
  ConnectorPasteConfig,
  ConnectorRegistry,
  ConnectorsScreen,
} from './ConnectorsScreen.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { ProviderEditor } from './ProviderEditor.js';
import { BackButton, ScreenBody } from './ScreenUI.js';
import screen from './Screen.module.css';
import {
  AccountSection,
  ConsentsSection,
  DeveloperSection,
  GeneralSection,
  ModelsSection,
} from './SettingsSections.js';
import styles from './SettingsPage.module.css';
import { SkillBrowser, SkillImport, SkillsScreen } from './SkillsScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';
import { settingsPage, type SettingsSheet } from './settingsNav';

export type { SettingsSheet } from './settingsNav';

function PageContent({ sheet, onOpenGlassLab }: { sheet: SettingsSheet; onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  switch (sheet) {
    case 'settings':
    case 'general':
      return <GeneralSection />;
    case 'providers':
      return <ModelsSection />;
    case 'provider-editor':
      if (store.editingProviderId && !store.hydrated) return <p role="status" className={screen.empty}>Loading provider…</p>;
    if (store.editingProviderId && !store.providers.some((p) => p.id === store.editingProviderId))
        return <p role="alert" className={screen.error}>Provider not found.</p>;
      return <ProviderEditor key={store.editingProviderId ?? 'new-provider'} />;
    case 'image-reader':
      return <ImageReaderScreen />;
    case 'voice-settings':
      return <VoiceSettingsScreen />;
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
    case 'saved-values':
      return <ScreenBody><SavedValues/></ScreenBody>;
    case 'consents':
      return <ConsentsSection />;
    case 'account':
      return <AccountSection />;
    case 'developer':
      return <DeveloperSection onOpenGlassLab={onOpenGlassLab} />;
  }
}

/**
 * The Settings content: a normal routed page in the space beside the floating
 * navigation, which Settings has taken over (see shell/Sidebar). No modal, no
 * second rail, no page header: the way out is the panel's back control.
 */
export function SettingsPage({
  sheet,
  onOpenGlassLab,
}: {
  sheet: SettingsSheet;
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  const page = settingsPage(sheet);
  const provider = store.providers.find((p) => p.id === store.editingProviderId);
  const title = sheet === 'provider-editor' ? (provider?.name ?? 'Add provider') : page.title;
  const shift = useContentShift();

  return (
    <div className={styles.pageShell} data-testid="settings-page" aria-label={title}>
      {!store.desktopSidebarOpen ? (
        <div className={styles.navCluster}>
          <GlassIconButton
            label="Open sidebar"
            data-testid="nav-sidebar-button"
            onClick={() => store.setDesktopSidebarOpen(true)}
          >
            <PanelLeft size={18} />
          </GlassIconButton>
        </div>
      ) : null}
      <motion.div
        className={styles.pane}
        data-nested={!!page.parent}
        initial={false}
        animate={{ x: shift }}
        transition={PANEL}
      >
        {page.parent ? (
          <div className={styles.subHeader}>
            <BackButton onClick={() => store.setActiveSheet(page.parent ?? 'settings')} />
            {sheet === 'provider-editor' ? (
              <button className={screen.textButton} type="submit" form="provider-editor-form">
                Save
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={styles.pageStack}>
          <div className={styles.page}>
            <PageContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
          </div>
        </div>
      </motion.div>
    </div>
  );
}
