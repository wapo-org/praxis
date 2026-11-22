import { describe, expect, it } from 'vitest';
import type { ActiveToolStep } from '../state/types';
import { appState, connectVerb, friendlyToolLabel, searchApps } from './apps';
import { connectRequestToolkits } from './connectRequests';

describe('App Directory helpers', () => {
  it('derives one state per app from the live connections', () => {
    const ready = { state: 'ready' as const, byToolkit: new Map([['gmail', 'failed' as const]]) };
    expect(appState(ready, 'gmail')).toBe('failed');
    expect(appState(ready, 'slack')).toBe('disconnected');
    expect(appState({ state: 'loading' }, 'gmail')).toBe('loading');
    expect(appState({ state: 'error' }, 'gmail')).toBe('unavailable');
    expect(connectVerb('failed')).toBe('Reconnect');
    expect(connectVerb('pending')).toBe('Continue connecting');
    expect(connectVerb('disconnected')).toBe('Connect');
  });

  it('searches names and descriptions without case', () => {
    expect(searchApps('').length).toBe(7);
    expect(searchApps('  SLACK ').map((app) => app.toolkit)).toEqual(['slack']);
    expect(searchApps('email').map((app) => app.toolkit)).toEqual(['gmail']);
    expect(searchApps('nothing like this')).toEqual([]);
  });

  it('reads Tool Router meta-tool names and taint labels as a connected app', () => {
    expect(friendlyToolLabel('COMPOSIO_MULTI_EXECUTE_TOOL', 'Connected app action')).toBe('Connected app action');
    expect(friendlyToolLabel('COMPOSIO MULTI EXECUTE TOOL', 'a connected app')).toBe('a connected app');
    expect(friendlyToolLabel('local fetch', 'a connected app')).toBe('local fetch');
  });

  it('collects each requested toolkit once and ignores other tool content', () => {
    const step = (content: Record<string, unknown>[]) =>
      ({ completion: { type: 'tool.completion', status: 'failed', summary: '', preview: '', content } }) as unknown as ActiveToolStep;
    const request = (toolkit: string) => ({
      type: 'composio.connect-required',
      toolkits: [{ toolkit, connectorId: `composio:${toolkit}` }],
    });
    const steps = [step([request('slack'), { type: 'text', text: 'x' }]), step([request('slack')]), step([request('gmail')])];
    expect(connectRequestToolkits(steps)).toEqual(['slack', 'gmail']);
    expect(connectRequestToolkits([step([{ type: 'composio.connect-required', toolkits: [] }])])).toEqual([]);
  });
});
