import { GlassIconButton, pageChange, PANEL, slideIn, usePreset, useReducedMotion } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
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
import { BackButton } from './ScreenUI.js';
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
import { settingsDepth, settingsPage, type SettingsSheet } from './settingsNav';

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
 * second rail, no close button: the way out is the panel's back row.
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
  const reduced = useReducedMotion();
  const shift = useContentShift();

  const previous = React.useRef(sheet);
  const forward = settingsDepth(sheet) >= settingsDepth(previous.current);
  React.useEffect(() => {
    previous.current = sheet;
  }, [sheet]);
  const nested = usePreset(slideIn);
  const settle = usePreset(pageChange);
  // A push for nested pages; sibling sections just settle in place.
  const enter = page.parent || settingsDepth(previous.current) === 2
    ? { ...nested, initial: reduced ? nested.initial : { opacity: 0, x: forward ? 24 : -24 } }
    : settle;

  return (
    <div className={styles.pageShell} data-testid="settings-page">
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
      <motion.div className={styles.pane} initial={false} animate={{ x: shift }} transition={PANEL}>
        <header className={styles.paneHeader} data-nested={!!page.parent}>
          {page.parent ? <BackButton onClick={() => store.setActiveSheet(page.parent ?? 'settings')} /> : null}
          <h1 className={styles.paneTitle}>{title}</h1>
          {sheet === 'provider-editor' ? (
            <button className={screen.textButton} type="submit" form="provider-editor-form">
              Save
            </button>
          ) : null}
        </header>
        <div className={styles.pageStack}>
          <AnimatePresence initial={false}>
            <motion.div key={sheet} className={styles.page} {...enter}>
              <PageContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
