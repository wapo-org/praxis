// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveToolStep } from '../../state/types';
import { AgentActivityView } from './AgentActivityView';
import { workEntries } from './ActivityDetails';
import { deepParse, parseLoose, JsonView } from './JsonView';
import { thoughtSummary, type ReasoningBlock } from './ReasoningView';
import { parseMcpName, toolDisplay } from './toolDisplay';
import { ToolInspector } from './ToolInspector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (callId: string, name: string, args: unknown = {}, extra: Record<string, unknown> = {}): ActiveToolStep =>
  ({
    callId,
    activity: { type: 'tool.activity', id: callId, name, source: { type: 'builtin' }, presentation: { type: 'tool.presentation', category: 'other', runningTitle: name, finishedTitle: name }, ...extra },
    argumentsJson: JSON.stringify(args),
    running: false,
    progressLines: [],
    completion: { type: 'tool.completion', status: 'succeeded', summary: 'ok', preview: 'ok' },
  }) as ActiveToolStep;
const thought = (id: string, text: string, over: Partial<ReasoningBlock> = {}): ReasoningBlock => ({ id, text, finished: true, durationMs: 1200, ...over });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
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
const q = (sel: string) => container.querySelectorAll(sel);

describe('one work group (WP-K2 item 1, K-ref/02, 07)', () => {
  it('renders one disclosure: no reasoning disclosures outside it', async () => {
    await render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:01:10Z" toolSteps={[tool('a', 'local_echo')]} reasoningBlocks={[thought('r1', '**Inspecting workspace**\nChecking.'), thought('r2', 'Done.', { afterToolCallId: 'a' })]} />);
    expect(q('[data-testid="agent-activity-toggle"]')).toHaveLength(1);
    expect(q('[data-testid="reasoning-view"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="agent-activity-toggle"]')?.textContent).toContain('Worked for 1m 10s');
  });

  it('says "Reasoned for" when the turn only reasoned, from the reasoning time', async () => {
    await render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:30Z" toolSteps={[]} reasoningBlocks={[thought('r1', 'Thinking about it.', { durationMs: 8000 })]} />);
    expect(container.querySelector('[data-testid="agent-activity-toggle"]')?.textContent).toContain('Reasoned for 8s');
  });

  it('never renders an empty reasoning row: no row, no chevron, and no group for empty thoughts alone', async () => {
    await render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:03Z" toolSteps={[]} reasoningBlocks={[thought('e1', ''), thought('e2', '   \n'), thought('e3', '', { redacted: true })]} />);
    expect(q('[data-testid="agent-activity-view"]')).toHaveLength(0);
    await render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:03Z" toolSteps={[tool('a', 'local_echo')]} reasoningBlocks={[thought('e1', ''), thought('e2', ' ', { afterToolCallId: 'a' })]} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]')!.click());
    expect(q('[data-testid="reasoning-row"]')).toHaveLength(0);
    expect(q('[data-testid^="tool-step-header-"]')).toHaveLength(1);
  });

  it('interleaves thoughts with calls in order, and keeps a thought whose call is unknown', () => {
    const entries = workEntries([tool('a', 'x'), tool('b', 'y')], [thought('r0', 'first'), thought('r1', 'after a', { afterToolCallId: 'a' }), thought('r9', 'orphan', { afterToolCallId: 'zz' }), thought('r2', 'after b', { afterToolCallId: 'b' })]);
    expect(entries.map((e) => (e.kind === 'tool' ? e.step.callId : e.block.id))).toEqual(['r0', 'a', 'r1', 'b', 'r2', 'r9']);
  });

  it('shows the live thought under the folded header, then folds it when it ends', async () => {
    const live = thought('r1', '**Inspecting workspace**\nChecking the repo.', { finished: false });
    await render(<AgentActivityView runId="run" isRunning startedAt="2026-01-01T00:00:00Z" toolSteps={[]} reasoningBlocks={[live]} />);
    expect(container.querySelector('[data-testid="agent-activity-peek"]')?.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="agent-activity-toggle"]')?.textContent).not.toContain('Inspecting workspace');
    await render(<AgentActivityView runId="run" isRunning startedAt="2026-01-01T00:00:00Z" toolSteps={[]} reasoningBlocks={[{ ...live, finished: true }]} />);
    expect(container.querySelector('[data-testid="agent-activity-peek"]')?.getAttribute('data-open')).toBe('false');
  });

  it('summarises a thought by its title or first sentence', () => {
    expect(thoughtSummary('**Inspecting workspace**\nChecking the repo.')).toBe('Inspecting workspace');
    expect(thoughtSummary('I should check the tool schema first. Then run it.')).toBe('I should check the tool schema first.');
    expect(thoughtSummary('Searching\nChecking types', 'titles', true)).toBe('Checking types');
  });
});

describe('readable tool rows (item 2, K-ref/04)', () => {
  it('parses hashed MCP names and drops the repeated server name', () => {
    expect(parseMcpName('mcp__firecrawl__firecrawl_search_bbc9571288db')).toEqual({ server: 'firecrawl', tool: 'search' });
    expect(parseMcpName('mcp__exa__web_search_exa_97cd22498a62')).toEqual({ server: 'exa', tool: 'web search' });
    expect(parseMcpName('local_echo')).toBeNull();
  });
  it('humanises direct calls and the catalogue meta-tools; technical names only for the detail', () => {
    const direct = toolDisplay(tool('a', 'mcp__firecrawl__firecrawl_search_bbc9571288db', { query: 'Firecrawl pricing', limit: 3 }));
    expect(direct).toMatchObject({ title: 'Firecrawl · search', detail: 'Firecrawl pricing', technical: 'mcp__firecrawl__firecrawl_search_bbc9571288db' });
    const call = toolDisplay(tool('b', 'mcp_call_tool', { tool: 'mcp__firecrawl__firecrawl_crawl_ece4ef24cbd6', arguments: { url: 'https://example.com' } }));
    expect(call).toMatchObject({ title: 'Firecrawl · crawl', detail: 'https://example.com' });
    const describe = toolDisplay(tool('c', 'mcp_describe_tool', { tool: 'mcp__firecrawl__firecrawl_search_bbc9571288db' }));
    expect(describe.title).toBe('Look up Firecrawl · search');
    for (const d of [direct, call, describe]) {
      expect(`${d.title} ${d.detail}`).not.toMatch(/mcp_|[0-9a-f]{10}|Mcp call tool/);
    }
  });
  it('prefers the API display contract and keeps originalName for the detail', () => {
    const d = toolDisplay(tool('a', 'firecrawl_search', { query: 'x' }, { display: { title: 'Firecrawl search', detail: 'pricing', connectorName: 'Firecrawl', icon: 'search' }, originalName: 'mcp__firecrawl__firecrawl_search_bbc9571288db' }));
    expect(d).toEqual({ title: 'Firecrawl search', detail: 'pricing', connectorName: 'Firecrawl', icon: 'search', technical: 'mcp__firecrawl__firecrawl_search_bbc9571288db' });
  });
});

describe('the display contract as K1 ships it', () => {
  it('names the inner tool when the API sends a generic catalogue title', () => {
    const d = toolDisplay(tool('b', 'mcp_call_tool', { tool: 'mcp__firecrawl__firecrawl_crawl_ece4ef24cbd6', arguments: { url: 'https://example.com' } }, { display: { title: 'Call connector tool', icon: 'Wrench' } }));
    expect(d).toMatchObject({ title: 'Firecrawl · crawl', detail: 'https://example.com' });
  });
  it('renders PascalCase lucide names, and keeps a specific glyph over a generic one', async () => {
    await render(<AgentActivityView startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:03Z" toolSteps={[
      tool('a', 'load_skill', { name: 'x' }, { display: { title: 'Load skill', icon: 'BookOpen' } }),
      tool('b', 'firecrawl_search', { query: 'q' }, { display: { title: 'Firecrawl search', detail: 'q', connectorName: 'Firecrawl', icon: 'Plug' } }),
    ]} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="agent-activity-toggle"]')!.click());
    expect(container.querySelector('[data-testid="tool-step-header-a"] svg')?.getAttribute('class')).toContain('lucide-book-open');
    expect(container.querySelector('[data-testid="tool-step-header-b"] svg')?.getAttribute('class')).toContain('lucide-search');
    expect(container.querySelector('[data-testid="tool-step-header-b"]')?.textContent).toContain('Firecrawl search');
  });
});

describe('the tool inspector (item 3, K-ref/05)', () => {
  it('parses JSON in strings, and escaped newlines in text', () => {
    expect(parseLoose('"{\\"a\\":1}"')).toEqual({ kind: 'json', value: { a: 1 } });
    expect(deepParse({ content: [{ type: 'text', text: '{"ok":true}' }] })).toEqual({ content: [{ type: 'text', text: { ok: true } }] });
    expect(parseLoose('# Pricing\\n\\n100,000 credits')).toEqual({ kind: 'text', text: '# Pricing\n\n100,000 credits' });
    expect(parseLoose('plain')).toEqual({ kind: 'text', text: 'plain' });
  });
  it('collapses big arrays into "▸ N items" that expand inline, and highlights tokens', async () => {
    await render(<JsonView value={{ ids: Array.from({ length: 24 }, (_, i) => i), ok: true, name: 'x', deep: { a: { b: { c: 1 } } } }} />);
    const collapsed = [...q('[data-testid="json-collapsed"]')].map((b) => b.textContent);
    expect(collapsed).toContain('▸ 24 items');
    expect(collapsed).toContain('▸ 1 key');
    await act(async () => (q('[data-testid="json-collapsed"]')[0] as HTMLButtonElement).click());
    expect(container.textContent).toContain('23');
    expect(container.querySelector('[class*="jBool"]')?.textContent).toBe('true');
    expect(container.querySelector('[class*="jKey"]')?.textContent).toBe('"ids"');
  });
  it('boxes input and output with captions and copy buttons', async () => {
    const copy = vi.fn();
    await render(<ToolInspector id="s" technical="mcp__x__y_123456789a" failed={false} warning={false} input='{"q":"a"}' progress="" output='{"r":[1]}' copiedId={null} copyText={copy} />);
    expect([...q('section')].map((s) => s.getAttribute('data-caption'))).toEqual(['input', 'output']);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click());
    expect(copy).toHaveBeenCalledWith('s', '{\n  "r": [\n    1\n  ]\n}');
  });
});
