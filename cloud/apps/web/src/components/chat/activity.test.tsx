// @vitest-environment jsdom
import type { Approval, Message } from '@praxis/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveToolStep } from '../../state/types';
import {
  activityLabel,
  argumentSummary,
  formatElapsed,
  humanizeToolName,
  outcomeNote,
  stepTag,
  stepTitle,
} from './activityLine';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import { groupTranscript } from './AssistantTurn';
import { ElicitationCard, elicitationPayload } from './ElicitationCards';
import { parseMarkdownBlocks } from './markdownBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (over: Partial<ActiveToolStep> = {}, title = 'local_echo'): ActiveToolStep => ({
  callId: 'c1',
  activity: {
    type: 'tool.activity',
    id: 'c1',
    name: 'local_echo',
    source: { type: 'builtin' },
    presentation: { type: 'tool.presentation', category: 'other', runningTitle: `Running ${title}`, finishedTitle: title },
  },
  argumentsJson: '{}',
  running: false,
  progressLines: [],
  ...over,
});
const approval = (over: Partial<Approval> = {}): Approval => ({
  type: 'approval',
  id: 'a1',
  callId: 'c1',
  toolName: 'local_write',
  source: { type: 'mcp', serverName: 'Local' },
  arguments: { path: 'notes.md' },
  reason: 'May change or delete data',
  title: 'Allow local_write?',
  ...over,
});

describe('activity labels', () => {
  it('reads like iOS, and under a second never reads 0s', () => {
    expect(formatElapsed(400)).toBe('<1s');
    expect(formatElapsed(0)).toBe('<1s');
    expect(formatElapsed(3000)).toBe('3s');
    expect(formatElapsed(65000)).toBe('1m 5s');
    const start = '2026-01-01T00:00:00Z';
    expect(activityLabel('running', start)).toBe('Currently working…');
    expect(activityLabel('finished', start, '2026-01-01T00:00:06Z')).toBe('Worked for 6s');
    expect(activityLabel('stopped', start, '2026-01-01T00:00:05Z')).toBe('Stopped after 5s');
    expect(activityLabel('stopped')).toBe('Stopped');
  });
  it('writes the outcome note only for turns that ended early, and a stop leaves it to the line', () => {
    expect(outcomeNote('failed', 'failed', 'HTTP 500')).toBe("Couldn't finish: HTTP 500");
    expect(outcomeNote('failed')).toBe("Couldn't finish");
    expect(outcomeNote('completed', 'truncated')).toContain('Cut off');
    expect(outcomeNote('completed', 'completed')).toBeNull();
    expect(outcomeNote('cancelled', 'cancelled')).toBeNull();
  });
});

describe('tool lines', () => {
  it('never shows a raw tool name or the same label twice', () => {
    expect(humanizeToolName('local_echo')).toBe('Local echo');
    expect(humanizeToolName('mcp__github__list_issues')).toBe('List issues');
    expect(humanizeToolName('readFile')).toBe('Read file');
    expect(stepTitle(step())).toBe('Local echo');
    expect(stepTitle(step({ running: true }))).toBe('Local echo…');
    expect(stepTitle(step({}, 'Searched the web'))).toBe('Searched the web');
    const html = renderToStaticMarkup(<AgentActivityView toolSteps={[step()]} />);
    expect(html).not.toContain('local_echo');
  });
  it('summarises the key argument, and not when the title already says it', () => {
    const args = (json: string) => step({ argumentsJson: json });
    expect(argumentSummary(args('{"limit":3,"query":"glass\\n blur"}'), 'Searched')).toBe('glass blur');
    expect(argumentSummary(args('{"query":"glass"}'), 'Searched for glass')).toBeUndefined();
    expect(argumentSummary(args('{}'), 'Echo')).toBeUndefined();
    expect(argumentSummary(args('not json'), 'Echo')).toBeUndefined();
  });
  it('tags lines that ended badly', () => {
    const done = (status: 'failed' | 'denied' | 'cancelled' | 'succeeded') =>
      step({ completion: { type: 'tool.completion', status, summary: status, preview: '' } });
    expect(stepTag(done('failed'))).toEqual({ text: 'Failed', danger: true });
    expect(stepTag(done('denied'))?.text).toBe('Declined');
    expect(stepTag(done('cancelled'))?.text).toBe('Stopped');
    expect(stepTag(done('succeeded'))).toBeUndefined();
  });
});

describe('AgentActivityView', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

  it('folds to a plain line, opens the list, then a call’s details', async () => {
    const done = step(
      {
        argumentsJson: '{"query":"blur"}',
        completion: { type: 'tool.completion', status: 'succeeded', summary: 'succeeded', preview: 'Three results' },
      },
      'Searched the web',
    );
    await act(async () =>
      root.render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:00.300Z" toolSteps={[done]} />),
    );
    expect(q('agent-activity-toggle').textContent).toBe('Worked for <1s');
    expect(q('agent-activity-steps')).toBeNull();
    await act(async () => q('agent-activity-toggle').click());
    expect(q('agent-activity-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(q('tool-step-header-c1').textContent).toContain('Searched the web: blur');
    await act(async () => q('tool-step-header-c1').click());
    const detail = q('tool-step-detail-c1').textContent;
    expect(detail).toContain('Call');
    expect(detail).toContain('Result');
    expect(detail).toContain('Three results');
    // "succeeded" repeats the status, so it isn't printed as an outcome.
    expect(detail).not.toContain('succeeded');
  });

  it('shimmers while working and after a stop, never on a finished run, and shows the live call', async () => {
    const running = step({ running: true, argumentsJson: '{"url":"https://example.com"}' });
    await act(async () => root.render(<AgentActivityView isRunning toolSteps={[running]} />));
    expect(q('agent-activity-toggle').textContent).toContain('Currently working…');
    expect(q('agent-activity-toggle').querySelector('[aria-hidden="true"] span')).not.toBeNull();
    expect(q('agent-activity-live').textContent).toContain('Local echo…: https://example.com');
    await act(async () =>
      root.render(<AgentActivityView isStopped startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:05Z" toolSteps={[running]} />),
    );
    expect(q('agent-activity-toggle').textContent).toContain('Stopped after 5s');
    expect(q('agent-activity-live')).toBeNull();
    // A stopped run never leaves a line pulsing.
    await act(async () => q('agent-activity-toggle').click());
    expect(container.querySelector('[data-running]')).toBeNull();
    await act(async () =>
      root.render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:05Z" toolSteps={[running]} />),
    );
    expect(q('agent-activity-toggle').querySelector('[aria-hidden="true"] span')).toBeNull();
  });

  it('answers an approval from the keyboard-reachable buttons, shown without opening anything', async () => {
    const resolve = vi.fn();
    await act(async () =>
      root.render(
        <AgentActivityView isRunning runId="r1" toolSteps={[step({ running: true })]} pendingApprovals={[approval()]} onResolveApproval={resolve} />,
      ),
    );
    const card = q('approval-card-a1');
    expect(card.textContent).toContain('Allow local write?');
    expect(card.textContent).not.toContain('local_write');
    expect(card.textContent).toContain('notes.md');
    for (const [id, decision] of [['approval-allow-once', 'allowOnce'], ['approval-allow-always', 'allowAlways'], ['approval-deny', 'deny']] as const) {
      const button = q(id);
      expect(button.tagName).toBe('BUTTON');
      expect(button.tabIndex).toBe(0);
      await act(async () => button.click());
      expect(resolve).toHaveBeenLastCalledWith('r1', 'a1', decision);
    }
  });

  it('moves a nested approval under its parent line and says it came from code', async () => {
    const nested = approval({ callId: 'inner', parentCallId: 'c1' });
    await act(async () =>
      root.render(<AgentActivityView isRunning runId="r1" toolSteps={[step({ running: true })]} pendingApprovals={[nested]} />),
    );
    expect(q('approval-card-a1').textContent).toContain('From code');
    expect(q('approval-card-a1').textContent).toContain('It waits for your answer');
    await act(async () => q('agent-activity-toggle').click());
    expect(q('tool-step-c1').contains(q('approval-card-a1'))).toBe(true);
    expect(container.querySelectorAll('[data-testid="approval-card-a1"]')).toHaveLength(1);
  });

  it('submits a clarifying question with Enter, and blocks an empty required field', async () => {
    const resolve = vi.fn();
    const elicitation = {
      id: 'e1',
      message: 'Provide a name',
      schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    };
    await act(async () => root.render(<ElicitationCard elicitation={elicitation} runId="r1" onResolveElicitation={resolve} />));
    const form = container.querySelector('form')!;
    const input = q('elicitation-input-name') as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(form.checkValidity()).toBe(false);
    expect(form.querySelector('label')!.textContent).toBe('Name');
    expect(elicitationPayload({ name: {} }, {})).toEqual({});
    expect(elicitationPayload({ env: { default: 'staging' }, n: { type: 'number' } }, { n: '3' })).toEqual({ env: 'staging', n: 3 });
    await act(async () => q('elicitation-cancel').click());
    expect(resolve).toHaveBeenLastCalledWith('r1', 'e1', 'cancel', undefined);
    await act(async () => q('elicitation-decline').click());
    expect(resolve).toHaveBeenLastCalledWith('r1', 'e1', 'decline', undefined);
  });

  it('opens a sign-in link only for a safe URL', async () => {
    const render = (url: string) =>
      renderToStaticMarkup(<ElicitationCard elicitation={{ id: 'e', message: 'Sign in', schema: {}, mode: 'url', url }} />);
    const safe = render('https://example.com/oauth');
    expect(safe).toContain('href="https://example.com/oauth"');
    expect(safe).toContain('rel="noreferrer"');
    expect(render('javascript:alert(1)')).not.toContain('href=');
  });
});

describe('transcript', () => {
  const message = (id: string, role: Message['role'], runId?: string): Message =>
    ({ type: 'message', id, chatId: 'c', runId, sequence: 0, role, parts: [], createdAt: '', updatedAt: '' }) as Message;

  it('makes one turn per run, so a run has one activity line', () => {
    const items = groupTranscript([
      message('u1', 'user', 'r1'),
      message('a1', 'assistant', 'r1'),
      message('t1', 'tool', 'r1'),
      message('a2', 'assistant', 'r1'),
      message('u2', 'user', 'r2'),
      message('a3', 'assistant', 'r2'),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(items[1]!.kind === 'assistant' && items[1]!.messages.map((m) => m.id)).toEqual(['a1', 't1', 'a2']);
  });
  it('asks the snapshot about a run with no saved answer, but not the live one', () => {
    const history = [message('u1', 'user', 'r1'), message('u2', 'user', 'r2')];
    expect(groupTranscript(history, 'r2').map((i) => i.kind)).toEqual(['user', 'unanswered', 'user']);
    const live = groupTranscript([message('u', 'user', 'r'), message('a', 'assistant', 'r')], 'r');
    expect(live.map((i) => i.kind)).toEqual(['user']);
  });
});

describe('markdown', () => {
  it('parses GFM alignment, and a table may interrupt a paragraph', () => {
    const blocks = parseMarkdownBlocks('Intro line\n| A | B | C | D |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table']);
    expect(blocks[1]!.aligns).toEqual(['left', 'center', 'right', undefined]);
    const html = renderToStaticMarkup(<AgentMessageView text={'| A | B |\n| --: | :-: |\n| 1 | 2 |'} />);
    expect(html).toContain('data-align="right"');
    expect(html).toContain('data-align="center"');
  });
  it('gives code a labelled copy button and real headings', () => {
    const html = renderToStaticMarkup(<AgentMessageView text={'## Title\n\n```ts\nconst a = 1;\n```'} />);
    expect(html).toMatch(/<h2[^>]*data-level="2"/);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('const a = 1;');
  });
  it('keeps its XSS protections: no script links, no raw HTML', () => {
    const html = renderToStaticMarkup(
      <AgentMessageView text={'[x](javascript:alert(1)) <img src=x onerror=alert(1)> [ok](https://example.com)'} />,
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toMatch(/style="/);
  });
});
