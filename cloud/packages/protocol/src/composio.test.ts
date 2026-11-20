import {describe, expect, it} from 'vitest';
import {COMPOSIO_APPS, composioAppName, composioChatScopePatch, composioEnabledInChat} from './composio.js';

const open = {connectorIds: [], disabledConnectorIds: []};

describe('Composio chat scope', () => {
  it('allows every toolkit until one is disabled or the chat names its own set', () => {
    expect(composioEnabledInChat(open, 'gmail')).toBe(true);
    expect(composioEnabledInChat({...open, disabledConnectorIds: ['composio:gmail']}, 'gmail')).toBe(false);
    const named = {connectorIds: ['composio:slack', 'builtin-exa'], disabledConnectorIds: []};
    expect(composioEnabledInChat(named, 'slack')).toBe(true);
    expect(composioEnabledInChat(named, 'gmail')).toBe(false);
  });

  it('patches a chat so the toggle reads back the value it wrote', () => {
    const off = composioChatScopePatch(open, 'gmail', false);
    expect(off).toEqual({connectorIds: [], disabledConnectorIds: ['composio:gmail']});
    expect(composioEnabledInChat(off, 'gmail')).toBe(false);
    expect(composioChatScopePatch(off, 'gmail', true)).toEqual(open);

    const named = {connectorIds: ['composio:slack'], disabledConnectorIds: ['composio:gmail']};
    const on = composioChatScopePatch(named, 'gmail', true);
    expect(on).toEqual({connectorIds: ['composio:slack', 'composio:gmail'], disabledConnectorIds: []});
    expect(composioEnabledInChat(on, 'gmail')).toBe(true);
    expect(composioEnabledInChat(composioChatScopePatch(on, 'slack', false), 'slack')).toBe(false);
  });

  it('names catalogue apps and shows other slugs as themselves', () => {
    expect(new Set(COMPOSIO_APPS.map(app => app.toolkit)).size).toBe(COMPOSIO_APPS.length);
    expect(composioAppName('googlecalendar')).toBe('Google Calendar');
    expect(composioAppName('jira')).toBe('jira');
  });
});
