import React from 'react';
import { ChevronRight, FlaskConical, Link, Settings, Shield, Sparkles, Star, User } from '../../lib/icons';
import { usePraxisStore, type ActiveSheet } from '../../state/store.js';
import {
  ConnectorAddURL,
  ConnectorPasteConfig,
  ConnectorRegistry,
  ConnectorsScreen,
} from './ConnectorsScreen.js';
import { ConsentsScreen } from './ConsentSheet.js';
import { ImageReaderScreen } from './ImageReaderScreen.js';
import { OpenRouterCallback } from './OpenRouterCallback.js';
import { BackButton } from './ScreenUI.js';
import screen from './Screen.module.css';
import {
  AccountSection,
  DeveloperSection,
  GeneralSection,
  ModelsSection,
} from './SettingsSections.js';
import styles from './SettingsModal.module.css';
import { SkillBrowser, SkillImport, SkillsScreen } from './SkillsScreen.js';
import { VoiceSettingsScreen } from './VoiceSettingsScreen.js';

export type SettingsSheet = Exclude<NonNullable<ActiveSheet>, 'history'>;
type Section = 'general' | 'models' | 'connectors' | 'skills' | 'consents' | 'account' | 'developer';

const NAV: Array<{ sheet: Section; title: string; Icon: typeof Settings; devOnly?: boolean }> = [
  { sheet: 'general', title: 'General', Icon: Settings },
  { sheet: 'models', title: 'Models', Icon: Star },
  { sheet: 'connectors', title: 'Connectors', Icon: Link },
  { sheet: 'skills', title: 'Skills', Icon: Sparkles },
  { sheet: 'consents', title: 'Data & privacy', Icon: Shield },
  { sheet: 'account', title: 'Account', Icon: User },
  { sheet: 'developer', title: 'Developer', Icon: FlaskConical, devOnly: true },
];

/** Every page: which section it belongs to, what its back button returns to, and how deep it sits. */
const PAGES: Record<Exclude<SettingsSheet, 'settings'>, { title: string; section: Section; parent?: SettingsSheet }> = {
  general: { title: 'General', section: 'general' },
  'voice-settings': { title: 'Voice input', section: 'general', parent: 'general' },
  models: { title: 'Models', section: 'models' },
  'openrouter-callback': { title: 'Connect OpenRouter', section: 'models', parent: 'models' },
  'image-reader': { title: 'Image reading model', section: 'models', parent: 'models' },
  connectors: { title: 'Connectors', section: 'connectors' },
  'connector-add-url': { title: 'Add by URL', section: 'connectors', parent: 'connectors' },
  'connector-paste-config': { title: 'Paste a config', section: 'connectors', parent: 'connectors' },
  'connector-registry': { title: 'MCP registry', section: 'connectors', parent: 'connectors' },
  skills: { title: 'Skills', section: 'skills' },
  'skill-import': { title: 'Import skill', section: 'skills', parent: 'skills' },
  'skill-browser': { title: 'Browse skills', section: 'skills', parent: 'skills' },
  consents: { title: 'Data & privacy', section: 'consents' },
  account: { title: 'Account', section: 'account' },
  developer: { title: 'Developer', section: 'developer' },
};

const depth = (sheet: SettingsSheet) =>
  sheet === 'settings' ? 0 : PAGES[sheet].parent ? 2 : 1;

function PageContent({ sheet, onOpenGlassLab }: { sheet: SettingsSheet; onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  switch (sheet) {
    case 'settings':
    case 'general':
      return <GeneralSection />;
    case 'models':
      return <ModelsSection />;
    case 'openrouter-callback':
      return <OpenRouterCallback />;
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
      return <ConsentsScreen />;
    case 'account':
      return <AccountSection />;
    case 'developer':
      return <DeveloperSection onOpenGlassLab={onOpenGlassLab} />;
  }
}

/**
 * The Settings surface. The bare /settings route shows General beside the rail on desktop and the
 * section list on narrow screens; which one is visible is CSS only (see the module's breakpoints).
 */
export function SettingsModal({
  sheet,
  onOpenGlassLab,
}: {
  sheet: SettingsSheet;
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  const isRoot = sheet === 'settings';
  const page = isRoot ? PAGES.general : PAGES[sheet];
  const title = page.title;

  const previous = React.useRef(sheet);
  const direction = depth(sheet) >= depth(previous.current) ? 'forward' : 'back';
  React.useEffect(() => {
    previous.current = sheet;
  }, [sheet]);

  const close = () => store.setActiveSheet(null);
  const back = () => store.setActiveSheet(page.parent ?? 'settings');
  const done = (
    <button type="button" aria-label="Close settings" onClick={close} className={screen.textButton}>
      Done
    </button>
  );
  const items = NAV.filter((item) => !item.devOnly || (import.meta.env.DEV && onOpenGlassLab));

  return (
    <div className={styles.modal} data-root={isRoot}>
      {isRoot ? (
        <div className={styles.rootHeader}>
          <h1 className={styles.paneTitle}>Settings</h1>
          {done}
        </div>
      ) : null}
      <nav className={styles.nav} aria-label="Settings sections">
        <p className={styles.navTitle}>Settings</p>
        <div className={styles.navList}>
          {items.map(({ sheet: target, title: label, Icon }) => (
            <button
              key={target}
              type="button"
              className={styles.navRow}
              data-testid={`settings-nav-${target}`}
              aria-current={page.section === target ? 'page' : undefined}
              onClick={() => store.setActiveSheet(target)}
            >
              <span className={styles.navIcon}>
                <Icon size={18} />
              </span>
              <span className={styles.navLabel}>{label}</span>
              <span className={styles.navChevron}>
                <ChevronRight size={16} />
              </span>
            </button>
          ))}
        </div>
      </nav>
      <div className={styles.pane}>
        <header className={styles.paneHeader} data-nested={!!page.parent}>
          {page.parent ? (
            <BackButton onClick={back} />
          ) : (
            <BackButton className={styles.back} onClick={back} data-section-root="true" />
          )}
          <h1 className={styles.paneTitle}>{title}</h1>
          {done}
        </header>
        <div className={styles.page} key={sheet} data-direction={direction} data-testid="settings-page">
          <PageContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
        </div>
      </div>
    </div>
  );
}
