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
import styles from './ReasoningView.module.css';
const choices = new Map<string,boolean>();
export type ReasoningBlock = Omit<RunBlock, 'type'>;
export function ReasoningView({ block }: { block: ReasoningBlock }) {
  const [choice, setChoice] = React.useState<boolean | null>(() => choices.get(block.id) ?? null);
  const live = !block.finished;
  const open = choice ?? live;
  const revealed = usePacedText(block.text,live);
  const text = (live || revealed !== block.text) && block.shape !== 'titles' ? stableStreamingMarkdown(revealed) : revealed;
  const label = reasoningLabel(live, block.durationMs ?? computeElapsedMs(block.startedAt, block.finishedAt));
  const body = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (live && choice !== true && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, live, choice]);
  return <section className={styles.root} data-testid="reasoning-view" data-shape={block.shape ?? 'raw'} data-live={live}>
    <button type="button" aria-expanded={open} aria-controls={`reasoning-${block.id}`} className={styles.header} onClick={() => { holdScrollPosition(body.current); choices.set(block.id,!open); if(choices.size>500) choices.delete(choices.keys().next().value!); setChoice(!open); }}>
      <span className={live ? 'praxis-shimmer-text' : undefined}>{label}</span><span className={`${styles.chevron} ${fold.chevron}`} aria-hidden="true"><ChevronRight size={16} /></span>
    </button>
    <span className={styles.sr} role="status" aria-live="polite">{live ? 'Reasoning started' : 'Reasoning finished'}</span>
    <Fold open={open && !!block.text && !block.redacted}>
        <div id={`reasoning-${block.id}`} ref={body} className={styles.body} data-capped={live && choice !== true}>
          {block.shape === 'titles' ? text.split('\n').filter(Boolean).map((line, i, lines) => <div key={i} className={live && i === lines.length - 1 ? 'praxis-shimmer-text' : undefined}>{line.replace(/^\*\*|\*\*$/g, '')}</div>) :
          reasoningSegments(text).map((part, i) => part.title ? <h4 key={i} className={styles.title}>{part.text}</h4> : <span key={i}>{renderInlineTokens(part.text, () => {})}</span>)}
        </div>
    </Fold>
  </section>;
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
