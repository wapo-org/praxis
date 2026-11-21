import {SavedValues} from './SavedSecrets';
import { GlassIconButton, PANEL } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { ChevronLeft, PanelLeft } from '../../lib/icons';
import { useIsNarrow } from '../shell/useIsNarrow';
import { usePraxisStore } from '../../state/store.js';
import { useContentShift } from '../shell/useContentShift';
import { AppConnectedScreen } from './AppConnectedScreen.js';
import { AppDirectoryScreen } from './AppDirectoryScreen.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { BackButton, ScreenBody } from './ScreenUI.js';
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
  switch (sheet) {
    case 'settings':
    case 'general':
      return <GeneralSection />;
    case 'models':
      return <ModelsSection />;
    case 'image-reader':
      return <ImageReaderScreen />;
    case 'voice-settings':
      return <VoiceSettingsScreen />;
    case 'apps':
      return <AppDirectoryScreen />;
    case 'app-connected':
      return <AppConnectedScreen />;
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

export function SettingsPage({
  sheet,
  onOpenGlassLab,
}: {
  sheet: SettingsSheet;
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  const page = settingsPage(sheet);
  const title = page.title;
  const shift = useContentShift();
  const narrow = useIsNarrow();
  React.useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) store.setActiveSheet(null);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [store]);

  return (
    <div className={styles.pageShell} data-testid="settings-page" aria-label={title}>
      {!store.desktopSidebarOpen ? (
        <div className={styles.navCluster}>
          {narrow && <button type="button" onClick={() => store.setActiveSheet(null)} aria-label="Close Settings"><ChevronLeft size={18} /> Back</button>}
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
