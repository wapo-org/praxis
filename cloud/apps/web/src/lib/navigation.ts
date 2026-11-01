import type { ActiveSheet } from '../state/store';
export const sheetPaths: Partial<Record<NonNullable<ActiveSheet>, string>> = {
  history: '/chats', settings: '/settings', providers: '/settings/providers',
  connectors: '/settings/connectors', 'connector-add-url': '/settings/connectors/add',
  'connector-paste-config': '/settings/connectors/config', 'connector-registry': '/settings/connectors/registry',
  skills: '/settings/skills', 'skill-import': '/settings/skills/import', 'skill-browser': '/settings/skills/browse',
  'image-reader': '/settings/images', 'voice-settings': '/settings/voice', consents: '/settings/sharing',
};
export function pathForSheet(sheet: ActiveSheet, chatId: string | null, providerId: string | null) {
  if (!sheet) return chatId ? `/c/${encodeURIComponent(chatId)}` : '/';
  if (sheet === 'provider-editor') return `/settings/providers/${encodeURIComponent(providerId ?? 'new')}`;
  return sheetPaths[sheet] ?? '/';
}
export function parseRoute(path: string): { chatId?: string; sheet: ActiveSheet; providerId?: string | null; valid: boolean } {
  try {
    if (path === '/') return { sheet: null, valid: true };
    const chat = /^\/c\/([^/]+)$/.exec(path);
    if (chat) return { chatId: decodeURIComponent(chat[1]!), sheet: null, valid: true };
    const sheet = Object.entries(sheetPaths).find(([, value]) => value === path)?.[0] as ActiveSheet;
    if (sheet) return { sheet, valid: true };
    const provider = /^\/settings\/providers\/([^/]+)$/.exec(path);
    if (provider) return { sheet: 'provider-editor', providerId: provider[1] === 'new' ? null : decodeURIComponent(provider[1]!), valid: true };
  } catch { /* Bad URL encoding is an unknown route. */ }
  return { sheet: null, valid: false };
}
