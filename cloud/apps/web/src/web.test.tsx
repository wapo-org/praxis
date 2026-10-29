import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlassRuntime } from '@praxis/glass';
import { PraxisStoreProvider } from './state/store';
import { UserBubble } from './components/chat/UserBubble';
import { AgentActivityView } from './components/chat/AgentActivityView';
import { AgentMessageView } from './components/chat/AgentMessageView';
import { ChatScreen } from './components/chat/ChatScreen';
import { GlassLabPage } from './components/lab/GlassLabPage';

describe('@praxis/web core chat & lab components', () => {
  it('renders UserBubble with text and attachments', () => {
    const html = renderToStaticMarkup(
      <UserBubble
        message={{
          type: 'message',
          id: 'msg-1',
          chatId: 'welcome',
          role: 'user',
          parts: [
            { type: 'text', text: 'Inspect Snell refraction on liquid glass.' },
            { type: 'image', attachmentId: 'att-1' },
          ],
          createdAt: '2026-10-29T18:00:00Z',
          updatedAt: '2026-10-29T18:00:00Z',
        }}
        attachmentsById={{
          'att-1': {
            type: 'attachment',
            id: 'att-1',
            name: 'refraction.png',
            mediaType: 'image/png',
            size: 1024,
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            hiddenFromCode: false,
          },
        }}
      />,
    );
    expect(html).toContain('Inspect Snell refraction on liquid glass.');
    expect(html).toContain('user-message-bubble');
    expect(html).toContain('refraction.png');
  });

  it('renders AgentActivityView with tool steps, pending approval, and pending elicitation', () => {
    const html = renderToStaticMarkup(
      <GlassRuntime>
        <AgentActivityView
          runId="run-1"
          isRunning={true}
          toolSteps={[
            {
              callId: 'call-1',
              activity: {
                type: 'tool.activity',
                id: 'call-1',
                name: 'workspace.search',
                source: { type: 'builtin' },
                presentation: {
                  type: 'tool.presentation',
                  category: 'readFile',
                  runningTitle: 'Searching protocol definitions',
                  finishedTitle: 'Searched protocol definitions',
                },
              },
              argumentsJson: '{"query":"RunEvent"}',
              running: false,
              progressLines: ['Found 4 matches'],
              completion: {
                type: 'tool.completion',
                status: 'succeeded',
                summary: 'Found 4 matches',
                preview: '4 matches in index.ts',
              },
            },
          ]}
          pendingApprovals={[
            {
              type: 'approval',
              id: 'app-1',
              callId: 'call-2',
              toolName: 'bash.exec',
              source: { type: 'builtin' },
              title: 'Run shell command',
              reason: 'npm test',
              arguments: { cmd: 'npm test' },
            },
          ]}
          pendingElicitations={[
            {
              id: 'elic-1',
              message: 'Confirm target environment',
              schema: {
                type: 'object',
                properties: {
                  env: { type: 'string', title: 'Environment', default: 'staging' },
                },
              },
            },
          ]}
        />
      </GlassRuntime>,
    );
    expect(html).toContain('agent-activity-view');
    expect(html).toContain('approval-card-app-1');
    expect(html).toContain('Allow Once');
    expect(html).toContain('Always Allow');
    expect(html).toContain('Deny');
    expect(html).toContain('elicitation-card-elic-1');
    expect(html).toContain('Confirm target environment');
  });

  it('renders AgentMessageView with headings, GFM table, code block, and inline chips', () => {
    const markdown = [
      '# Liquid Glass Optics',
      '',
      'See `GlassSurface.tsx` and `cloud/packages/glass/src/index.ts#L10` or [Kube Snell Blog](https://kube.io/blog/liquid-glass-css-svg/).',
      '',
      '| Engine | Strategy | FPS |',
      '| --- | --- | --- |',
      '| Chromium | svg-displacement | 60 |',
      '| WebKit | progressive-frost | 60 |',
      '',
      '```ts',
      'const n = 1.5;',
      '```',
    ].join('\n');

    const html = renderToStaticMarkup(
      <AgentMessageView
        text={markdown}
        usage={{
          type: 'usage',
          inputTokens: 120,
          outputTokens: 85,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }}
      />,
    );
    expect(html).toContain('Liquid Glass Optics');
    expect(html).toContain('markdown-table-card');
    expect(html).toContain('svg-displacement');
    expect(html).toContain('markdown-code-block');
    expect(html).toContain('inline-file-chip');
    expect(html).toContain('inline-link-chip');
    expect(html).toContain('120 in · 85 out');
  });

  it('renders ChatScreen inside PraxisStoreProvider and GlassRuntime', () => {
    const html = renderToStaticMarkup(
      <GlassRuntime>
        <PraxisStoreProvider>
          <ChatScreen onOpenGlassLab={() => {}} />
        </PraxisStoreProvider>
      </GlassRuntime>,
    );
    expect(html).toContain('chat-screen');
    expect(html).toContain('chat-top-bar');
    expect(html).toContain('composer-surface');
    expect(html).toContain('What are we working on?');
  });

  it('renders GlassLabPage with Apple Notes 35-frame reference demo and 500-model virtual picker', () => {
    const html = renderToStaticMarkup(
      <GlassRuntime>
        <GlassLabPage onNavigateBack={() => {}} />
      </GlassRuntime>,
    );
    expect(html).toContain('Liquid Glass');
    expect(html).toContain('Recent Notes');
  });
});
