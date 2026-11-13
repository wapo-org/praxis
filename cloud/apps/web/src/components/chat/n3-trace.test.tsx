// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveToolStep } from '../../state/types';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';
import { AgentActivityView } from './AgentActivityView';
import { SourcesTrace } from './SourcesTrace';
import { ToolInspector } from './ToolInspector';
import { extractToolSources } from './toolSources';
import { formatTraceTitle, workEntry } from './WorkEntry.logic';
import type { ReasoningBlock } from './ReasoningView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (over: Partial<ActiveToolStep> & { callId?: string; name?: string } = {}): ActiveToolStep =>
  ({
    callId: over.callId ?? 'step-1',
    activity: {
      type: 'tool.activity',
      id: over.callId ?? 'step-1',
      name: over.name ?? 'mcp__exa__web_search_exa_226473000415',
      source: { type: 'mcp', serverId: 'exa', serverName: 'Exa' },
      presentation: {
        type: 'tool.presentation',
        category: 'webSearch',
        runningTitle: 'Searching the web',
        finishedTitle: 'Searched the web',
      },
      ...over.activity,
    },
    argumentsJson: over.argumentsJson ?? JSON.stringify({ query: 'hello world' }),
    running: over.running ?? false,
    progressLines: over.progressLines ?? [],
    startedAt: over.startedAt ?? '2026-11-13T00:00:00.000Z',
    finishedAt: over.finishedAt ?? '2026-11-13T00:00:01.400Z',
    completion: over.completion,
  }) as ActiveToolStep;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
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

const render = async (el: React.ReactNode) => act(async () => root.render(el));

describe('WP-N3 Trace primitives and work display', () => {
  it('renders Trace primitives with data-slot attributes, status styling, and keepMounted control', async () => {
    await render(
      <Trace>
        <TraceLine status="running">
          <TraceIcon>
            <svg />
          </TraceIcon>
          <TraceTitle>Searching the web</TraceTitle>
          <TraceDescription>3 results</TraceDescription>
        </TraceLine>
        <TraceCollapsible defaultOpen={false}>
          <TraceCollapsibleTrigger>
            <TraceLine status="pending">
              <TraceTitle>Pending step</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted>
            <span data-testid="kept-body">Kept body</span>
          </TraceCollapsibleContent>
        </TraceCollapsible>
        <TraceCollapsible defaultOpen={false}>
          <TraceCollapsibleTrigger>
            <TraceLine status="error">
              <TraceTitle>Error step</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted={false}>
            <span data-testid="unmounted-body">Unmounted body</span>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>,
    );

    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    const runningTitle = container.querySelector('[data-status="running"] [data-slot="trace-title"]');
    expect(runningTitle?.className).toContain('praxis-shimmer-text');
    expect(container.querySelector('[data-slot="trace-description"]')?.textContent).toBe('3 results');
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
    expect(container.querySelector('[data-status="error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kept-body"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="unmounted-body"]')).toBeNull();
  });

  it('converts Trace titles between present, past, and failed tenses and extracts descriptions', () => {
    expect(formatTraceTitle('Searching the web', 'running')).toBe('Searching the web');
    expect(formatTraceTitle('Searching the web', 'done')).toBe('Searched the web');
    expect(formatTraceTitle('Searching the web', 'failed')).toBe("Couldn't search the web");
    expect(formatTraceTitle('Running', 'running')).toBe('Running');
    expect(formatTraceTitle('Running', 'done')).toBe('Ran');
    expect(formatTraceTitle('Running', 'failed')).toBe('Failed to run');

    const runningEntry = workEntry(step({ running: true }));
    expect(runningEntry.title).toBe('Searching the web');
    expect(runningEntry.connector).toBe(' for ');

    const doneEntry = workEntry(
      step({
        running: false,
        completion: {
          type: 'tool.completion',
          status: 'succeeded',
          summary: 'ok',
          preview:
            'Title: First\nURL: https://example.com/a\n\nTitle: Second\nURL: https://example.org/b',
        },
      }),
    );
    expect(doneEntry.title).toBe('Searched the web');
    expect(doneEntry.description).toBe('2 results · 1.4s');

    const fetchEntry = workEntry(
      step({
        name: 'mcp__firecrawl__firecrawl_scrape_abcdef1234',
        argumentsJson: JSON.stringify({ url: 'https://www.docs.example.com/guide' }),
        running: false,
        completion: { type: 'tool.completion', status: 'succeeded', summary: 'ok', preview: 'hi' },
      }),
    );
    expect(fetchEntry.description).toContain('1.4s');
  });

  it('uses open ?? running on tool rows and renders destructive error block for failures', async () => {
    const runningStep = step({
      callId: 's-run',
      running: true,
      completion: undefined,
    });
    const failedStep = step({
      callId: 's-err',
      name: 'shell_exec',
      activity: {
        type: 'tool.activity',
        id: 's-err',
        name: 'shell_exec',
        source: { type: 'builtin' },
        presentation: {
          type: 'tool.presentation',
          category: 'command',
          runningTitle: 'Running',
          finishedTitle: 'Ran',
        },
      },
      argumentsJson: JSON.stringify({ command: 'pnpm -v' }),
      running: false,
      completion: {
        type: 'tool.completion',
        status: 'failed',
        summary: 'command not found: pnpm',
        preview: 'command not found: pnpm',
      },
    });

    await render(
      <AgentActivityView
        isRunning
        startedAt="2026-11-13T00:00:00.000Z"
        toolSteps={[runningStep, failedStep]}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]')!.click();
    });

    const runHeader = container.querySelector<HTMLButtonElement>('[data-testid="tool-step-header-s-run"]')!;
    const errHeader = container.querySelector<HTMLButtonElement>('[data-testid="tool-step-header-s-err"]')!;
    expect(runHeader.getAttribute('aria-expanded')).toBe('true');
    expect(errHeader.getAttribute('aria-expanded')).toBe('false');
    expect(errHeader.querySelector('[data-status="error"]')).not.toBeNull();
    expect(errHeader.textContent).toContain('Failed to run');

    // User click overrides open ?? running
    await act(async () => {
      runHeader.click();
      errHeader.click();
    });
    expect(runHeader.getAttribute('aria-expanded')).toBe('false');
    expect(errHeader.getAttribute('aria-expanded')).toBe('true');
    const destructive = container.querySelector(
      '[data-testid="tool-step-detail-s-err"] [data-variant="destructive"]',
    );
    expect(destructive).not.toBeNull();
    expect(destructive?.textContent).toContain('command not found: pnpm');
  });

  it('shows live unredacted empty reasoning as a static TraceLine until text arrives', async () => {
    const emptyLive: ReasoningBlock = { id: 'r-live', text: '', finished: false };
    await render(
      <AgentActivityView
        isRunning
        startedAt="2026-11-13T00:00:00.000Z"
        toolSteps={[step({ running: true })]}
        reasoningBlocks={[emptyLive]}
      />,
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]')!.click();
    });

    const line = container.querySelector('[data-testid="reasoning-row"] [data-slot="trace-line"]');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('data-status')).toBe('running');
    expect(line?.textContent).toBe('Thinking');

    await render(
      <AgentActivityView
        isRunning
        startedAt="2026-11-13T00:00:00.000Z"
        toolSteps={[step({ running: true })]}
        reasoningBlocks={[{ ...emptyLive, text: 'Checking files first.' }]}
      />,
    );
    expect(container.querySelector('[data-testid="reasoning-row"] [aria-expanded]')).not.toBeNull();
  });

  it('deduplicates extracted sources across Exa and Firecrawl formats and renders new-tab link rows', async () => {
    const exaStep = step({
      callId: 'exa-1',
      completion: {
        type: 'tool.completion',
        status: 'succeeded',
        summary: 'ok',
        preview:
          'Title: Alpha Doc\nURL: https://example.com/a\n\nTitle: Beta\nURL: https://www.sub.example.org/b\n\nTitle: Unsafe\nURL: javascript:alert(1)',
      },
    });
    const fcStep = step({
      callId: 'fc-1',
      completion: {
        type: 'tool.completion',
        status: 'succeeded',
        summary: 'ok',
        preview: JSON.stringify({
          data: {
            web: [
              { title: 'Alpha duplicate', url: 'https://example.com/a' },
              { title: 'Gamma', url: 'https://gamma.dev/guide' },
            ],
          },
        }),
      },
    });

    const sources = extractToolSources([exaStep, fcStep]);
    expect(sources.map((s) => s.url)).toEqual([
      'https://example.com/a',
      'https://www.sub.example.org/b',
      'https://gamma.dev/guide',
    ]);
    expect(sources.map((s) => s.domain)).toEqual(['example.com', 'sub.example.org', 'gamma.dev']);

    await render(<SourcesTrace sources={sources} />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="turn-sources-toggle"]')!;
    expect(toggle.textContent).toContain('Used 3 sources');
    await act(async () => toggle.click());
    const links = [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="turn-source-link"]')];
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer');
      expect(a.textContent).toContain('(opens in a new tab)');
    }
  });

  it('tracks progressive edge fades and footer Show all / Show less on scrollable output', async () => {
    await render(
      <ToolInspector
        id="scroll-test"
        failed={false}
        warning={false}
        input=""
        progress=""
        output={Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n')}
        copiedId={null}
        copyText={vi.fn()}
      />,
    );

    const content = container.querySelector<HTMLPreElement>(
      'section[data-caption="output"] [data-slot="code-block-content"]',
    )!;
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(content, 'clientHeight', { configurable: true, value: 272 });
    let top = 0;
    Object.defineProperty(content, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });

    await act(async () => {
      content.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(content.getAttribute('data-fade')).toBe('bottom');
    const footerBtn = container.querySelector<HTMLButtonElement>('section[data-caption="output"] [data-slot="code-block-footer"] button')!;
    expect(footerBtn.textContent).toBe('Show all');

    top = 150;
    await act(async () => {
      content.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(content.getAttribute('data-fade')).toBe('both');

    top = 528;
    await act(async () => {
      content.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(content.getAttribute('data-fade')).toBe('top');

    await act(async () => {
      footerBtn.click();
    });
    expect(content.getAttribute('data-expanded')).toBe('true');
    expect(content.getAttribute('data-fade')).toBe('none');
    expect(footerBtn.textContent).toBe('Show less');
  });
});
