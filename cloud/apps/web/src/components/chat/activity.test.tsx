// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveToolStep } from '../../state/store';
import { AgentActivityView } from './AgentActivityView';
import {
  bindSendFlightTarget,
  cancelSendFlight,
  isSendFlightActive,
  launchSendFlight,
  SEND_FLIGHT_DURATION_MS,
  sendBubbleShapeAt,
  subscribeSendFlight,
} from './chatMotion';
import {
  computeElapsedMs,
  formatDuration,
  formatWorkingTimer,
  stoppedLabel,
  workedLabel,
} from './useActivityClock';

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
  cancelSendFlight();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(el: React.ReactNode) {
  await act(async () => root.render(el));
}

describe('agent activity header (t3code TurnFoldTimelineRow + iOS parity)', () => {
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
    expect(toggle?.hasAttribute('data-scroll-anchor-ignore')).toBe(true);
    // No pill: no background, border, dot, or version badge.
    expect(container.querySelector('[data-testid="agent-activity-view"]')?.textContent).not.toContain(
      'Completed activity',
    );
    expect(toggle?.style.background).toBe('');
    expect(container.querySelector('span[style*="border-radius: 50%"]')).toBeNull();
  });

  it('shimmers "Working" and shows live elapsed timer while running', async () => {
    await render(
      <AgentActivityView
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={true}
        toolSteps={[step({ running: true, statusText: 'Searching…' })]}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]');
    expect(toggle?.textContent).toContain('Working');
    expect(toggle?.querySelector('.praxis-shimmer-text')).not.toBeNull();
  });

  it('formats sub-second, seconds, minutes, and hours like t3-code and never says Worked for 0s', () => {
    expect(formatDuration(0)).toBe('1ms');
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(1250)).toBe('1.3s');
    expect(formatDuration(3000)).toBe('3s');
    expect(formatDuration(14200)).toBe('14s');
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(3723000)).toBe('1h 2m 3s');

    expect(workedLabel('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(
      'Worked for 1ms',
    );
    expect(workedLabel('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.350Z')).toBe(
      'Worked for 350ms',
    );
    expect(
      workedLabel(
        '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:00.500Z',
      ),
    ).toBe('Worked for 1.5s');
    expect(stoppedLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z')).toBe('Stopped after 3s');
    expect(workedLabel('2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z')).toBe('Worked for 3s');
    expect(computeElapsedMs('2026-01-01T00:00:03Z', '2026-01-01T00:00:00Z')).toBeNull();
    expect(formatWorkingTimer('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:05Z'))).toBe(
      '1m 5s',
    );
  });

  it('shows "Stopped after…" and auto-opens fold when a running turn is cancelled', async () => {
    await render(
      <AgentActivityView
        runId="r-cancel"
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={true}
        runStatus="running"
        toolSteps={[step({ running: true })]}
      />,
    );
    await render(
      <AgentActivityView
        runId="r-cancel"
        startedAt="2026-01-01T00:00:00Z"
        finishedAt="2026-01-01T00:00:03Z"
        isRunning={false}
        runStatus="cancelled"
        toolSteps={[step()]}
      />,
    );
    expect(container.textContent).toContain('Stopped after 3s');
    expect(container.textContent).not.toContain('Worked for');
    expect(
      container.querySelector('[data-testid="agent-activity-toggle"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('shows waiting states and stays accessible', async () => {
    await render(
      <AgentActivityView
        isRunning={false}
        toolSteps={[]}
        pendingApprovals={[
          {type: 'approval', id: 'ap1', callId: 'call-1', title: 'Delete file?', toolName: 'delete',
            source: {type: 'builtin'}, arguments: 'Path: test.txt', reason: 'Changes the workspace'},
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

describe('iMessage send animation trajectory (chatMotion)', () => {
  const fromBox = { left: 52, top: 800, width: 290, height: 36 };
  const toBox = { left: 280, top: 560, width: 64, height: 36 };

  it('restores the calibrated 820ms trajectory and settles without a second bounce', () => {
    expect(SEND_FLIGHT_DURATION_MS).toBe(820);
    expect(sendBubbleShapeAt(0, fromBox, toBox).width).toBe(fromBox.width);
    expect(sendBubbleShapeAt(36, fromBox, toBox).fillOpacity).toBe(1);
    expect(sendBubbleShapeAt(40, fromBox, toBox).top).toBeLessThan(fromBox.top);
    expect(sendBubbleShapeAt(200, fromBox, toBox).width).toBeCloseTo(toBox.width, 1);
    const peak=sendBubbleShapeAt(430, fromBox, toBox);
    expect(toBox.top-peak.top).toBeGreaterThanOrEqual(4);
    expect(toBox.top-peak.top).toBeLessThanOrEqual(7);
    const landing=[480,560,640,720,820].map(t=>sendBubbleShapeAt(t,fromBox,toBox).top);
    expect(landing).toEqual([...landing].sort((a,b)=>a-b));
    expect(landing.at(-1)).toBeCloseTo(toBox.top,1);
  });

  it('notifies subscribers when a send flight starts and ends', () => {
    const input = document.createElement('textarea');
    input.getBoundingClientRect = () => new DOMRect(64, 800, 270, 36);
    document.body.appendChild(input);

    const events: boolean[] = [];
    const unsub = subscribeSendFlight(() => events.push(isSendFlightActive()));
    expect(isSendFlightActive()).toBe(false);

    launchSendFlight(input, 'First');
    expect(isSendFlightActive()).toBe(true);
    cancelSendFlight();
    expect(isSendFlightActive()).toBe(false);
    expect(events).toEqual([true, false]);

    unsub();
    input.remove();
  });

  it('keeps retiring optimistic targets hidden until the keyed handoff flight ends', () => {
    const input = document.createElement('textarea');
    input.getBoundingClientRect = () => new DOMRect(64, 800, 270, 36);
    document.body.appendChild(input);
    const old = document.createElement('div');
    const next = document.createElement('div');
    for (const bubble of [old, next]) {
      bubble.getBoundingClientRect = () => new DOMRect(280, 520, 64, 36);
      document.body.appendChild(bubble);
    }
    launchSendFlight(input, 'Same message');
    bindSendFlightTarget(old);
    bindSendFlightTarget(next);
    expect(old.style.visibility).toBe('hidden');
    expect(next.style.visibility).toBe('hidden');
    cancelSendFlight();
    expect(old.style.visibility).toBe('');
    expect(next.style.visibility).toBe('');
    input.remove();
    old.remove();
    next.remove();
  });

  it('cleans up previous flight on rapid consecutive sends so no bubble stays hidden', () => {
    const input = document.createElement('textarea');
    input.getBoundingClientRect = () => new DOMRect(64, 800, 270, 36);
    document.body.appendChild(input);

    const bubble1 = document.createElement('div');
    bubble1.getBoundingClientRect = () => new DOMRect(280, 520, 64, 36);
    document.body.appendChild(bubble1);

    const bubble2 = document.createElement('div');
    bubble2.getBoundingClientRect = () => new DOMRect(280, 568, 64, 36);
    document.body.appendChild(bubble2);

    launchSendFlight(input, 'First');
    bindSendFlightTarget(bubble1);
    expect(bubble1.style.opacity).toBe('0');

    // Second send mid-flight immediately reveals bubble1 and hides bubble2.
    launchSendFlight(input, 'Second');
    expect(bubble1.style.opacity).toBe('');
    bindSendFlightTarget(bubble2);
    expect(bubble2.style.opacity).toBe('0');
    expect(document.querySelectorAll('[data-testid="send-flight-bubble"]')).toHaveLength(1);

    cancelSendFlight();
    expect(bubble2.style.opacity).toBe('');
    expect(document.querySelectorAll('[data-testid="send-flight-bubble"]')).toHaveLength(0);

    input.remove();
    bubble1.remove();
    bubble2.remove();
  });
});
