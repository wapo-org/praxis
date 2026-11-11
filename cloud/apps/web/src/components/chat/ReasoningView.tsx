import React from 'react';
import type { RunBlock } from '@praxis/protocol';
import { ChevronRight } from '../../lib/icons';
import { Fold } from './Fold';
import fold from './Fold.module.css';
import { computeElapsedMs, formatDuration } from './useActivityClock';
import { renderInlineTokens } from './InlineTokens';
import {stableStreamingMarkdown} from './streamingMarkdown';
import {usePacedText} from './usePacedText';
import { holdScrollPosition } from './Fold';
import { WorkLogLine, workLogStyles as log } from './WorkLog';
import { Brain } from 'lucide-react';
import { bindIcon } from '@praxis/glass';
import styles from './ReasoningView.module.css';
const BrainIcon = bindIcon(Brain);
const choices = new Map<string,boolean>();
const remember = (id: string, open: boolean) => { choices.set(id, open); if (choices.size > 500) choices.delete(choices.keys().next().value!); };
export type ReasoningBlock = Omit<RunBlock, 'type'>;

/** A reasoning block has something to show: text the provider did not redact. */
export const hasThought = (b: ReasoningBlock) => !b.redacted && !!b.text?.trim();

/** The thought's body: paced while live, capped and pinned to its latest line until the user opens it. */
export function ReasoningBody({ block, capped, id }: { block: ReasoningBlock; capped: boolean; id?: string }) {
  const live = !block.finished;
  const revealed = usePacedText(block.text, live);
  const text = (live || revealed !== block.text) && block.shape !== 'titles' ? stableStreamingMarkdown(revealed) : revealed;
  const body = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (capped && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, capped]);
  return <div id={id} ref={body} className={styles.body} data-capped={capped}>
    {block.shape === 'titles' ? text.split('\n').filter(Boolean).map((line, i, lines) => <div key={i} className={live && i === lines.length - 1 ? 'praxis-shimmer-text' : undefined}>{line.replace(/^\*\*|\*\*$/g, '')}</div>) :
    reasoningSegments(text).map((part, i) => part.title ? <h4 key={i} className={styles.title}>{part.text}</h4> : <span key={i}>{renderInlineTokens(part.text, () => {})}</span>)}
  </div>;
}

/** Standalone reasoning disclosure (the stream lab). In chat, reasoning is a row inside "Worked for". */
export function ReasoningView({ block }: { block: ReasoningBlock }) {
  const [choice, setChoice] = React.useState<boolean | null>(() => choices.get(block.id) ?? null);
  const live = !block.finished;
  const open = choice ?? live;
  const label = reasoningLabel(live, block.durationMs ?? computeElapsedMs(block.startedAt, block.finishedAt));
  const ref = React.useRef<HTMLElement>(null);
  return <section ref={ref} className={styles.root} data-testid="reasoning-view" data-shape={block.shape ?? 'raw'} data-live={live}>
    <button type="button" aria-expanded={open} aria-controls={`reasoning-${block.id}`} className={styles.header} onClick={() => { holdScrollPosition(ref.current); remember(block.id, !open); setChoice(!open); }}>
      <span className={live ? 'praxis-shimmer-text' : undefined}>{label}</span><span className={`${styles.chevron} ${fold.chevron}`} aria-hidden="true"><ChevronRight size={16} /></span>
    </button>
    <span className={styles.sr} role="status" aria-live="polite">{live ? 'Reasoning started' : 'Reasoning finished'}</span>
    <Fold open={open && !!block.text && !block.redacted}>
      <ReasoningBody block={block} capped={live && choice !== true} id={`reasoning-${block.id}`} />
    </Fold>
  </section>;
}

/**
 * One thought inside the work group (K-ref/02, 07; t3-code's reasoning work entry): a brain glyph on the
 * column edge and the thought's own short summary, which opens to the full text. A thought with nothing to
 * show has no row at all.
 */
export function ThoughtRow({ block, onToggle }: { block: ReasoningBlock; onToggle?: (el: Element | null) => void }) {
  const [choice, setChoice] = React.useState<boolean | null>(() => choices.get(block.id) ?? null);
  const ref = React.useRef<HTMLDivElement>(null);
  if (!hasThought(block)) return null;
  const live = !block.finished;
  const open = choice ?? live;
  const summary = thoughtSummary(block.text, block.shape, live);
  return <div ref={ref} className={log.row} data-testid="reasoning-row" data-live={live} data-shape={block.shape ?? 'raw'}>
    <button type="button" className={log.button} aria-expanded={open} aria-controls={`thought-${block.id}`} onClick={() => { onToggle?.(ref.current); holdScrollPosition(ref.current); remember(block.id, !open); setChoice(!open); }}>
      <WorkLogLine icon={<span className={log.icon} data-kind="thought"><BrainIcon size={16} /></span>} trailing={<span className={`${log.chevron} ${fold.chevron}`} aria-hidden="true"><ChevronRight size={16} /></span>}>
        <span className={live ? 'praxis-shimmer-text' : undefined}>{summary || (live ? 'Thinking' : 'Thought')}</span>
      </WorkLogLine>
    </button>
    <Fold open={open} id={`thought-${block.id}`}>
      <div className={styles.indent}><ReasoningBody block={block} capped={live && choice !== true} /></div>
    </Fold>
  </div>;
}

/** The thought's title: its first **Title** (or, for title streams, the latest line), else its first sentence. */
export function thoughtSummary(text: string, shape?: string, live = false): string {
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  if (shape === 'titles') {
    const lines = text.split('\n').map(clean).filter(Boolean);
    return (live ? lines.at(-1) : lines[0]) ?? '';
  }
  const titles = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => clean(m[1]!)).filter(Boolean);
  if (titles.length) return (live ? titles.at(-1) : titles[0])!;
  const flat = clean(text.replace(/^#+\s*/gm, ''));
  const sentence = /^(.{8,}?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

/** Never a zero duration: under a second it reasoned briefly; unknown, it simply reasoned. */
export function reasoningLabel(live: boolean, ms: number | null | undefined): string {
  if (live) return 'Reasoning…';
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'Reasoned';
  return ms < 1000 ? 'Reasoned briefly' : `Reasoned for ${formatDuration(ms)}`;
}

/**
 * Splits **Title** lines from the prose. The newlines around a title are the title's own spacing, so they
 * are dropped from the prose beside it (pre-wrap would otherwise add a blank line under every heading).
 */
export function reasoningSegments(text: string): Array<{ title: boolean; text: string }> {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  const isTitle = (p: string | undefined) => !!p && /^\*\*[^*\n]+\*\*$/.test(p);
  return parts.flatMap((part, i): Array<{ title: boolean; text: string }> => {
    if (isTitle(part)) return [{ title: true, text: part.slice(2, -2) }];
    let prose = part;
    if (isTitle(parts[i - 1])) prose = prose.replace(/^\s*\n/, '');
    if (isTitle(parts[i + 1])) prose = prose.replace(/\n\s*$/, '');
    return prose ? [{ title: false, text: prose }] : [];
  });
}
