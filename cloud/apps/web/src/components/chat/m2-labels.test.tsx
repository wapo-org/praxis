import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AgentActivityView } from './AgentActivityView';
import { extractMessageToolSteps } from './messageTools';
import { MessageSchema } from '@praxis/protocol';
import fixture from '../../../../../packages/agent/src/hello-replay.json';
import { toolDisplay } from './toolDisplay';
import { toolRowCopy } from './toolRowCopy';
import { workEntry } from './WorkEntry.logic';
import { messageTurns } from './messageTurns';
import { ResponseTimeline, savedTimeline } from './ResponseTimeline';

const MACHINE = /mcp__|_[0-9a-f]{8,}|[0-9]{9,}/;

describe('WP-M2 label humanisation', () => {
  it('a running legacy header cannot leak its raw status or presentation title', () => {
    const source = fixture.messages[1]!;
    const message = MessageSchema.parse({
      ...source,
      type: 'message',
      id: 'm',
      chatId: 'c',
      createdAt: '2026-11-13T00:00:00Z',
      updatedAt: '2026-11-13T00:00:10Z',
    });
    const step = extractMessageToolSteps(message)[0]!;
    step.running = true;
    step.statusText = 'Running ' + step.activity.name;
    step.activity.presentation!.runningTitle = step.statusText;
    const html = renderToStaticMarkup(
      <AgentActivityView isRunning startedAt={message.createdAt} toolSteps={[step]} />,
    );
    expect(html).toContain("Searching the web for &#x27;hello world example&#x27;");
    expect(html).not.toMatch(MACHINE);
  });

  it('formats web search and reading host labels cleanly', () => {
    const fetchStep = {
      callId: 'f1',
      activity: {
        type: 'tool.activity' as const,
        id: 'f1',
        name: 'mcp__firecrawl__firecrawl_scrape_abc1234567',
        source: { type: 'mcp' as const, serverId: 'fc', serverName: 'Firecrawl' },
        presentation: {
          type: 'tool.presentation' as const,
          category: 'other' as const,
          runningTitle: 'mcp__firecrawl__firecrawl_scrape_abc1234567',
          finishedTitle: 'mcp__firecrawl__firecrawl_scrape_abc1234567',
        },
      },
      argumentsJson: JSON.stringify({ url: 'https://www.clarkesworldmagazine.com/story' }),
      running: true,
      progressLines: [],
    };
    const display = toolDisplay(fetchStep);
    expect(display.title).toBe('Reading clarkesworldmagazine.com');
    const html = renderToStaticMarkup(
      <AgentActivityView isRunning startedAt="2026-11-13T00:00:00Z" toolSteps={[fetchStep]} />,
    );
    expect(html).toContain('Reading clarkesworldmagazine.com');
    expect(html).not.toMatch(MACHINE);
  });

  it('never leaks machine names in ResponseTimeline labels or ActivityDetails rows', () => {
    const messages = fixture.messages.map((m, i) =>
      MessageSchema.parse({
        ...m,
        type: 'message',
        id: String(i),
        chatId: 'hello',
        runId: i ? 'run' : undefined,
        createdAt: '2026-11-13T00:00:00Z',
        updatedAt: '2026-11-13T00:00:20Z',
      }),
    );
    const turn = messageTurns(messages)[1]!;
    const steps = extractMessageToolSteps(turn);
    for (const step of steps) {
      const d = toolDisplay(step);
      const copy = toolRowCopy(step);
      const entry = workEntry(step);
      for (const label of [
        d.title,
        d.detail,
        copy.title,
        copy.summary,
        entry.title,
        entry.preview,
        step.activity.presentation?.runningTitle,
        step.activity.presentation?.finishedTitle,
      ]) {
        expect(label ?? '').not.toMatch(MACHINE);
      }
    }
    const html = renderToStaticMarkup(
      <ResponseTimeline
        nodes={savedTimeline(turn, steps)}
        text="full turn text"
        activity={{
          runId: 'run',
          startedAt: turn.createdAt,
          finishedAt: turn.updatedAt,
          isRunning: false,
          toolSteps: steps,
        }}
      />,
    );
    expect(html).not.toMatch(MACHINE);
    expect(html).toContain('Worked for');
    expect(html).not.toContain('Reasoned for');
  });
});
