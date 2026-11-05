// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveToolStep } from '../../state/store';
import { AgentActivityView } from './AgentActivityView';
import { stoppedLabel, workedLabel } from './useActivityClock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (over: Partial<ActiveToolStep> = {}): ActiveToolStep =>
  ({
    callId: 'c1',
    activity: { id: 'a1', name: 'search', provider: 'local', version: 1 },
    argumentsJson: '{}',
    running: false,
    statusText: '',
    progressLines: [],
    ...over,
  }) as ActiveToolStep;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(el: React.ReactNode) {
  await act(async () => root.render(el));
}

describe('agent activity header (iOS parity)', () => {
  it('is plain text: chevron plus 13px medium label, no pill chrome', async () => {
    await render(
      <AgentActivityView
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={false}
        toolSteps={[step()]}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]');
    expect(toggle?.textContent).toContain('Worked for 3s');
    // No pill: no background, border, dot, or version badge.
    expect(container.querySelector('[data-testid="agent-activity-view"]')?.textContent).not.toContain(
      'Completed activity',
    );
    expect(toggle?.style.background).toBe('');
    expect(container.querySelector('span[style*="border-radius: 50%"]')).toBeNull();
  });

  it('shimmers "Currently working…" while running', async () => {
    await render(
      <AgentActivityView
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={true}
        toolSteps={[step({ running: true, statusText: 'Searching…' })]}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]');
    expect(toggle?.textContent).toContain('Currently working…');
    expect(toggle?.querySelector('.praxis-shimmer-text')).not.toBeNull();
  });

  it('says "Stopped after…" when the run was cancelled or failed', () => {
    expect(stoppedLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z')).toBe('Stopped after 3s');
    expect(workedLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z')).toBe('Worked for 3s');
  });

  it('shows "Stopped after…" for a cancelled run', async () => {
    await render(
      <AgentActivityView
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={false}
        runStatus="cancelled"
        toolSteps={[step()]}
      />,
    );
    expect(container.textContent).toContain('Stopped after 3s');
    expect(container.textContent).not.toContain('Worked for');
  });

  it('shows waiting states and stays accessible', async () => {
    await render(
      <AgentActivityView
        isRunning={false}
        toolSteps={[]}
        pendingApprovals={[
          { id: 'ap1', runId: 'r1', title: 'Delete file?', toolName: 'delete' } as never,
        ]}
      />,
    );
    const toggle = container.querySelector('[data-testid="agent-activity-toggle"]');
    expect(toggle?.textContent).toContain('Waiting for tool approval (1)');
    expect(container.querySelector('[data-testid="approval-card-ap1"]')).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => (toggle as HTMLButtonElement).click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Waiting for tool approval (1)');
  });
});
