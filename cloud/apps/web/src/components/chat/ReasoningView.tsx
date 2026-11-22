import React from 'react';
import type { RunBlock } from '@praxis/protocol';
import { Brain } from 'lucide-react';
import { bindIcon } from '@praxis/glass';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';
import { computeElapsedMs, formatDuration } from './useActivityClock';
import { renderInlineTokens } from './InlineTokens';
import { workLogStyles as log } from './WorkLog';
import styles from './ReasoningView.module.css';

const BrainIcon = bindIcon(Brain);
const choices = new Map<string, boolean>();
const remember = (id: string, open: boolean) => {
  choices.set(id, open);
  if (choices.size > 500) choices.delete(choices.keys().next().value!);
};

export type ReasoningBlock = Omit<RunBlock, 'type'> & { timelineOrder?: number };

/** A reasoning block has something to show: text the provider did not redact. */
export const hasThought = (b: ReasoningBlock) => !b.redacted && !!b.text?.trim();

/** The thought's body: paced while live, capped and pinned to its latest line until the user opens it. */
export function ReasoningBody({
  block,
  capped,
  id,
}: {
  block: ReasoningBlock;
  capped: boolean;
  id?: string;
}) {
  const live = !block.finished;
  // Live, an opened title (`**Ti`) waits for its closing marker, so `**` never flashes; a title is a few words.
  const text =
    live && block.shape !== 'titles' && (block.text.match(/\*\*/g)?.length ?? 0) % 2
      ? block.text.slice(0, block.text.lastIndexOf('**'))
      : block.text;
  const body = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (capped && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, capped]);
  return (
    <div id={id} ref={body} className={styles.body} data-capped={capped}>
      {block.shape === 'titles'
        ? text
            .split('\n')
            .filter(Boolean)
            .map((line, i, lines) => (
              <div
                key={i}
                className={live && i === lines.length - 1 ? 'praxis-shimmer-text' : undefined}
              >
                {line.replace(/^\*\*|\*\*$/g, '')}
              </div>
            ))
        : reasoningSegments(text).map((part, i) =>
            part.title ? (
              <h4 key={i} className={styles.title}>
                {part.text}
              </h4>
            ) : (
              <span key={i}>{renderInlineTokens(part.text, () => {})}</span>
            ),
          )}
    </div>
  );
}

/** Standalone reasoning disclosure (the stream lab). In chat, reasoning is a row inside "Worked for". */
export function ReasoningView({ block }: { block: ReasoningBlock }) {
  const [choice, setChoice] = React.useState<boolean | undefined>(() => choices.get(block.id));
  const live = !block.finished;
  const open = choice ?? live;
  const label = reasoningLabel(
    live,
    block.durationMs ?? computeElapsedMs(block.startedAt, block.finishedAt),
  );
  const ref = React.useRef<HTMLElement>(null);
  const canOpen = !!block.text && !block.redacted;

  return (
    <section
      ref={ref}
      className={styles.root}
      data-testid="reasoning-view"
      data-shape={block.shape ?? 'raw'}
      data-live={live}
    >
      <TraceCollapsible
        open={open}
        onOpenChange={(next) => {
          remember(block.id, next);
          setChoice(next);
        }}
      >
        <TraceCollapsibleTrigger aria-controls={`reasoning-${block.id}`} className={styles.header}>
          <TraceLine status={live ? 'running' : undefined}>
            <TraceTitle>{label}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <span className={styles.sr} role="status" aria-live="polite">
          {live ? 'Reasoning started' : 'Reasoning finished'}
        </span>
        <TraceCollapsibleContent id={`reasoning-${block.id}`} rail={false} keepMounted>
          {canOpen ? <ReasoningBody block={block} capped={live && choice !== true} /> : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </section>
  );
}

export function ThoughtRow({
  block,
  onToggle,
}: {
  block: ReasoningBlock;
  onToggle?: (el: Element | null) => void;
}) {
  const [choice, setChoice] = React.useState<boolean | undefined>(() => choices.get(block.id));
  const ref = React.useRef<HTMLDivElement>(null);
  const live = !block.finished;
  const withText = hasThought(block);

  if (!withText) {
    if (!live || block.redacted) return null;
    return (
      <div
        ref={ref}
        className={log.row}
        data-testid="reasoning-row"
        data-live="true"
        data-shape={block.shape ?? 'raw'}
      >
        <TraceLine status="running">
          <TraceIcon className={log.icon} data-kind="thought">
            <BrainIcon size={16} />
          </TraceIcon>
          <TraceTitle>Thinking</TraceTitle>
        </TraceLine>
      </div>
    );
  }

  const open = choice ?? live;
  const summary = thoughtSummary(block.text, block.shape, live);
  const duration =
    !live &&
    typeof block.durationMs === 'number' &&
    Number.isFinite(block.durationMs) &&
    block.durationMs >= 1000
      ? formatDuration(block.durationMs)
      : '';

  return (
    <div
      ref={ref}
      className={log.row}
      data-testid="reasoning-row"
      data-live={live}
      data-shape={block.shape ?? 'raw'}
    >
      <TraceCollapsible
        open={open}
        onOpenChange={(next) => {
          onToggle?.(ref.current);
          remember(block.id, next);
          setChoice(next);
        }}
      >
        <TraceCollapsibleTrigger aria-controls={`thought-${block.id}`} className={log.button}>
          <TraceLine status={live ? 'running' : undefined}>
            <TraceIcon className={log.icon} data-kind="thought">
              <BrainIcon size={16} />
            </TraceIcon>
            <TraceTitle>{summary || (live ? 'Thinking' : 'Thought')}</TraceTitle>
            {duration ? <TraceDescription>{duration}</TraceDescription> : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent id={`thought-${block.id}`} keepMounted>
          <div className={styles.indent}>
            <ReasoningBody block={block} capped={live && choice !== true} />
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </div>
  );
}

/** The thought's title: its first **Title** (or, for title streams, the latest line), else its first sentence. */
export function thoughtSummary(text: string, shape?: string, live = false): string {
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  if (shape === 'titles') {
    const lines = text.split('\n').map(clean).filter(Boolean);
    return (live ? lines.at(-1) : lines[0]) ?? '';
  }
  const titles = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)]
    .map((m) => clean(m[1]!))
    .filter(Boolean);
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
