import React from 'react';
import { Check, ChevronRight, Copy, Eye, FileText, Globe, Lightbulb, Link2, Pencil, Search, Terminal, Waypoints, Wrench } from '../../lib/icons';
import type { ActiveToolStep } from '../../state/types';
import { argumentSummary, stepArguments, stepSource, stepTag, stepTitle } from './activityLine';
import type { AgentActivityViewProps } from './activityTypes';
import styles from './AgentActivity.module.css';

type StepIcon = typeof Waypoints;

const CATEGORY_ICONS: Record<string, StepIcon> = {
  integration: Link2,
  command: Terminal,
  webSearch: Search,
  webFetch: Globe,
  readFile: FileText,
  edit: Pencil,
  skill: Wrench,
  other: Waypoints,
};

export function stepIcon(step: ActiveToolStep): StepIcon {
  return CATEGORY_ICONS[step.activity.presentation?.category ?? 'other'] ?? Waypoints;
}

function clipboardCopy(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text);
}

function DetailBlock({ label, text, danger, children }: { label: string; text: string; danger?: boolean; children?: React.ReactNode }) {
  return (
    <div className={styles.block}>
      <div className={styles.blockLabel} data-danger={danger}>
        <span>{label}</span>
        {children}
      </div>
      <pre className={styles.blockText}>{text}</pre>
    </div>
  );
}

/** One line per call. Same height everywhere; anything with details opens in place. */
function ActivityRow({
  id,
  testId,
  icon: Icon,
  source,
  title,
  detail,
  tag,
  running,
  label,
  children,
  waiting,
}: {
  id: string;
  testId?: string;
  icon: StepIcon;
  source?: string;
  title: string;
  detail?: string;
  tag?: { text: string; danger: boolean };
  running?: boolean;
  label?: string;
  children?: React.ReactNode;
  waiting?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const line = (
    <>
      <span className={styles.rowIcon} data-running={running || undefined}>
        <Icon size={16} />
      </span>
      <span className={styles.rowText}>
        {source ? <span className={styles.rowSource}>{source} · </span> : null}
        {title}
        {detail ? `: ${detail}` : null}
      </span>
      {tag ? (
        <span className={styles.tag} data-danger={tag.danger}>
          {tag.text}
        </span>
      ) : null}
    </>
  );
  return (
    <div data-testid={testId}>
      {children ? (
        <button
          type="button"
          className={styles.row}
          data-testid={`tool-step-header-${id}`}
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((value) => !value)}
        >
          {line}
          <span className={styles.rowChevron}>
            <ChevronRight size={16} />
          </span>
        </button>
      ) : (
        <div className={styles.row}>{line}</div>
      )}
      {waiting ? <div className={styles.waiting}>{waiting}</div> : null}
      {open && children ? (
        <div className={styles.details} data-testid={`tool-step-detail-${id}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({ step, waiting }: { step: ActiveToolStep; waiting?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const title = stepTitle(step);
  const source = stepSource(step);
  const detail = argumentSummary(step, title);
  const args = stepArguments(step);
  const failed = step.completion?.status === 'failed';
  const output = step.completion?.preview || '';
  const summary = step.completion?.summary;
  // The outcome, when it says more than the line and the status do.
  const note =
    !step.running && summary && ![title, output, step.completion?.status, 'Tool completed', 'Tool failed'].includes(summary)
      ? summary
      : undefined;
  const copy = () => {
    clipboardCopy(`${args}\n\n${output}`.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const hasDetails = Boolean(args || output || note || step.progressLines.length);
  const copyButton = (
    <button type="button" className={styles.copy} aria-label={copied ? 'Copied' : 'Copy call and result'} onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
  return (
    <ActivityRow
      id={step.callId}
      testId={`tool-step-${step.callId}`}
      icon={stepIcon(step)}
      source={source}
      title={title}
      detail={detail}
      tag={stepTag(step)}
      running={step.running}
      waiting={waiting}
    >
      {hasDetails ? (
        <>
          {note ? <p className={styles.note}>{note}</p> : null}
          {args ? (
            <DetailBlock label="Call" text={args}>
              {copyButton}
            </DetailBlock>
          ) : null}
          {step.progressLines.length ? <DetailBlock label="Progress" text={step.progressLines.join('\n')} /> : null}
          {output ? (
            <DetailBlock label={failed ? 'Error' : 'Result'} text={output} danger={failed}>
              {args ? null : copyButton}
            </DetailBlock>
          ) : null}
        </>
      ) : null}
    </ActivityRow>
  );
}

export function ActivityDetails({
  reasoningBlocks = [],
  visionActivities = [],
  compactions = [],
  toolSteps,
  waitingFor,
}: Pick<AgentActivityViewProps, 'reasoningBlocks' | 'visionActivities' | 'compactions' | 'toolSteps'> & {
  waitingFor: (callId: string) => React.ReactNode;
}) {
  return (
    <div data-testid="agent-activity-steps" className={styles.steps}>
      {reasoningBlocks.map((block) => (
        <div key={block.id} data-testid="agent-reasoning-block">
          <ActivityRow
            id={block.id}
            icon={Lightbulb}
            title={block.text.replace(/\s+/g, ' ').trim() || 'Thinking…'}
            running={!block.finished}
          >
            {block.text.trim() ? <DetailBlock label="Thinking" text={block.text} /> : null}
          </ActivityRow>
        </div>
      ))}
      {visionActivities.map((vision) => (
        <ActivityRow
          key={vision.id}
          id={vision.id}
          icon={Eye}
          title={vision.phase === 'started' ? 'Reading an image…' : vision.phase === 'failed' ? "Couldn't read an image" : 'Read an image'}
          detail={vision.modelId}
          tag={vision.phase === 'failed' ? { text: 'Failed', danger: true } : undefined}
          running={vision.phase === 'started'}
        >
          {vision.answer ? <DetailBlock label="Result" text={vision.answer} /> : null}
        </ActivityRow>
      ))}
      {compactions.map((compaction) => (
        <ActivityRow
          key={compaction.id}
          id={compaction.id}
          icon={FileText}
          title={compaction.phase === 'started' ? 'Condensing earlier messages…' : compaction.phase === 'failed' ? "Couldn't condense earlier messages" : 'Condensed earlier messages'}
          tag={compaction.phase === 'failed' ? { text: 'Failed', danger: true } : undefined}
          running={compaction.phase === 'started'}
        >
          {compaction.summary ? <DetailBlock label="Summary" text={compaction.summary} /> : null}
        </ActivityRow>
      ))}
      {toolSteps.map((step) => (
        <ToolRow key={step.callId} step={step} waiting={waitingFor(step.callId)} />
      ))}
    </div>
  );
}
