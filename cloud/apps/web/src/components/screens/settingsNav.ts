import { FlaskConical, Link, Settings, Shield, Sparkles, Star, User } from '../../lib/icons';
import type { ActiveSheet } from '../../state/store.js';

export type SettingsSheet = Exclude<NonNullable<ActiveSheet>, 'history'>;
export type SettingsSection = 'general' | 'providers' | 'connectors' | 'skills' | 'consents' | 'saved-values' | 'account' | 'developer';

export const SETTINGS_NAV: Array<{ sheet: SettingsSection; title: string; Icon: typeof Settings; devOnly?: boolean }> = [
  { sheet: 'general', title: 'General', Icon: Settings },
  { sheet: 'providers', title: 'Models & providers', Icon: Star },
  { sheet: 'connectors', title: 'Connectors', Icon: Link },
  { sheet: 'skills', title: 'Skills', Icon: Sparkles },
  { sheet: 'saved-values', title: 'Secrets & variables', Icon: Shield },
  { sheet: 'consents', title: 'Data & privacy', Icon: Shield },
  { sheet: 'account', title: 'Account', Icon: User },
  { sheet: 'developer', title: 'Developer', Icon: FlaskConical, devOnly: true },
];

/** Every page: which section it belongs to, what its back button returns to. */
export const SETTINGS_PAGES: Record<Exclude<SettingsSheet, 'settings'>, { title: string; section: SettingsSection; parent?: SettingsSheet }> = {
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
  'saved-values': {title:'Secrets & variables',section:'saved-values'},
  consents: { title: 'Data & privacy', section: 'consents' },
  account: { title: 'Account', section: 'account' },
  developer: { title: 'Developer', section: 'developer' },
};

export const settingsPage = (sheet: SettingsSheet) => (sheet === 'settings' ? SETTINGS_PAGES.general : SETTINGS_PAGES[sheet]);

export const isSettingsSheet = (sheet: ActiveSheet | undefined): sheet is SettingsSheet => !!sheet && sheet !== 'history';

export const settingsDepth = (sheet: SettingsSheet) => (sheet === 'settings' ? 0 : SETTINGS_PAGES[sheet].parent ? 2 : 1);
