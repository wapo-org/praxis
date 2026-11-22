// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConnect } from '../../hooks/useAppConnect';
import type { AppConnections } from '../../hooks/useAppConnections';
import type { ActiveToolStep } from '../../state/types';
import { AgentActivityView } from './AgentActivityView';
import { ApprovalCards } from './ApprovalCards';

let connections: AppConnections;
let actions: AppConnect;
const useConnections = vi.fn(() => connections);
vi.mock('../../hooks/useAppConnections', () => ({ useAppConnections: () => useConnections() }));
vi.mock('../../hooks/useAppConnect', () => ({ useAppConnect: () => actions }));

const connectStep = {
  callId: 'call-1',
  activity: {
    type: 'tool.activity', id: 'call-1', name: 'COMPOSIO_MULTI_EXECUTE_TOOL', source: { type: 'builtin' },
    presentation: { type: 'tool.presentation', category: 'other', runningTitle: 'Run', finishedTitle: 'Ran' },
  },
  argumentsJson: '{}',
  running: false,
  progressLines: [],
  completion: {
    type: 'tool.completion', status: 'failed', summary: 'failed', preview: '',
    content: [{ type: 'composio.connect-required', toolkits: [{ toolkit: 'slack', connectorId: 'composio:slack' }] }],
  },
} as ActiveToolStep;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  connections = { state: 'ready', byToolkit: new Map() };
  actions = { busy: null, error: null, connect: vi.fn(), disconnect: vi.fn() };
  useConnections.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(steps: ActiveToolStep[]) {
  await act(async () => root.render(<AgentActivityView runId="r" toolSteps={steps} />));
}

describe('in-chat app connect card', () => {
  it('asks to connect the app a tool result named, and connects from the card', async () => {
    await mount([connectStep]);
    const card = host.querySelector('section[aria-label="Connect Slack"]')!;
    expect(card.textContent).toContain('This needs Slack.');
    await act(async () => card.querySelector('button')!.click());
    expect(actions.connect).toHaveBeenCalledWith('slack');
  });

  it('asks to sign in again when the connection failed, and settles once it is connected', async () => {
    connections = { state: 'ready', byToolkit: new Map([['slack', 'failed']]) };
    await mount([connectStep]);
    expect(host.querySelector('section[aria-label="Reconnect Slack"]')!.textContent).toContain('needs you to sign in again');
    connections = { state: 'ready', byToolkit: new Map([['slack', 'connected']]) };
    await mount([connectStep]);
    expect(host.querySelector('section')).toBeNull();
    expect(host.querySelector('[data-testid="app-connect-done-slack"]')!.textContent).toContain('Slack connected');
  });

  it('does not subscribe to connections for a run that asked for nothing', async () => {
    await mount([{ ...connectStep, completion: { ...connectStep.completion!, content: [{ type: 'text', text: 'ok' }] } }]);
    expect(useConnections).not.toHaveBeenCalled();
  });
});

it('names a Composio meta-tool approval and taint after a connected app, not the raw tool', () => {
  const html = renderToStaticMarkup(
    <ApprovalCards
      pendingApprovals={[{
        type: 'approval', id: 'a', callId: 'c', toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL', title: '', arguments: '',
        reason: 'Needs approval', source: { type: 'builtin' }, taintSource: 'COMPOSIO MULTI EXECUTE TOOL',
      }]}
    />,
  );
  expect(html).toContain('Approval required · Connected app action');
  expect(html).toContain('This run read content from a connected app.');
  expect(html).not.toContain('COMPOSIO');
});
