import React from 'react';
import type { RunBlock } from '@praxis/protocol';
import { ChevronDown } from '../../lib/icons';
import { useActivityClock } from './useActivityClock';
import { renderInlineTokens } from './InlineTokens';
import styles from './ReasoningView.module.css';
const choices = new Map<string,boolean>();
export type ReasoningBlock = Omit<RunBlock, 'type'>;
export function ReasoningView({ block }: { block: ReasoningBlock }) {
  const [choice, setChoice] = React.useState<boolean | null>(() => choices.get(block.id) ?? null);
  const live = !block.finished;
  const open = choice ?? live;
  const clock = useActivityClock(live, block.startedAt, block.finishedAt);
  const duration = block.durationMs === undefined ? clock.replace('Worked for ', '') : `${Math.round(block.durationMs / 100) / 10}s`;
  const label = live ? 'Reasoning…' : `Reasoned for ${duration === 'Worked' ? '0s' : duration}`;
  const body = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (live && choice !== true && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [block.text, live, choice]);
  return <section className={styles.root} data-testid="reasoning-view" data-shape={block.shape ?? 'raw'} data-live={live}>
    <button type="button" aria-expanded={open} aria-controls={`reasoning-${block.id}`} className={styles.header} onClick={() => { choices.set(block.id,!open); if(choices.size>500) choices.delete(choices.keys().next().value!); setChoice(!open); }}>
      <span className={live ? 'praxis-shimmer-text' : undefined}>{label}</span><ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
    </button>
    <span className={styles.sr} role="status" aria-live="polite">{live ? 'Reasoning started' : 'Reasoning finished'}</span>
    <div className={styles.fold} data-open={open && !!block.text && !block.redacted}>
      <div className={styles.clip}>
        <div id={`reasoning-${block.id}`} ref={body} className={styles.body} data-capped={live && choice !== true}>
          {block.shape === 'titles' ? block.text.split('\n').filter(Boolean).map((line, i, lines) => <div key={i} className={live && i === lines.length - 1 ? 'praxis-shimmer-text' : undefined}>{line.replace(/^\*\*|\*\*$/g, '')}</div>) :
          block.text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => /^\*\*[^*\n]+\*\*$/.test(part) ? <h4 key={i} className={styles.title}>{part.slice(2, -2)}</h4> : <span key={i}>{renderInlineTokens(part, () => {})}</span>)}
        </div>
      </div>
    </div>
  </section>;
}
