import React from 'react';
import { ChevronRight, FlaskConical, Link, Settings, Shield, Sparkles, Star, User } from '../../lib/icons';
import { usePraxisStore, type ActiveSheet } from '../../state/store.js';
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

export type SettingsSheet = Exclude<NonNullable<ActiveSheet>, 'history'>;
type Section = 'general' | 'providers' | 'connectors' | 'skills' | 'consents' | 'account' | 'developer';

const NAV: Array<{ sheet: Section; title: string; Icon: typeof Settings; devOnly?: boolean }> = [
  { sheet: 'general', title: 'General', Icon: Settings },
  { sheet: 'providers', title: 'Models & providers', Icon: Star },
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
  providers: { title: 'Models & providers', section: 'providers' },
  'provider-editor': { title: 'Provider', section: 'providers', parent: 'providers' },
  'image-reader': { title: 'Image reading model', section: 'providers', parent: 'providers' },
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
 * The Settings page: a normal routed page in the main content area (no modal,
 * no scrim). The bare /settings route shows General beside the rail on desktop
 * and the section list on narrow screens; which one is visible is CSS only.
 */
export function SettingsPage({
  sheet,
  onOpenGlassLab,
}: {
  sheet: SettingsSheet;
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  const isRoot = sheet === 'settings';
  const page = isRoot ? PAGES.general : PAGES[sheet];
  const provider = store.providers.find((p) => p.id === store.editingProviderId);
  const title =
    sheet === 'provider-editor' ? (provider?.name ?? 'Add provider') : page.title;

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
    <div className={styles.pageShell} data-root={isRoot} data-sidebar={store.desktopSidebarOpen}>
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
          {sheet === 'provider-editor' ? (
            <button className={screen.textButton} type="submit" form="provider-editor-form">
              Save
            </button>
          ) : (
            done
          )}
        </header>
        <div className={styles.page} key={sheet} data-direction={direction} data-testid="settings-page">
          <PageContent sheet={sheet} onOpenGlassLab={onOpenGlassLab} />
        </div>
      </div>
    </div>
  );
}
