/*
 * Adapted from T3 Code WorkLog, TimelineWorkEntryRow, TimelineToolActivityIcon,
 * TimelineWorkGroupRows and MessagesTimeline (T3 Tools Inc.).
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { ThoughtRow, hasThought, type ReasoningBlock } from './ReasoningView';
import { workEntry } from './WorkEntry.logic';
import { ToolGlyph, workLogStyles as log } from './WorkLog';
import { ToolInspector } from './ToolInspector';
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
import styles from './Activity.module.css';
import type { AgentActivityViewProps } from './activityTypes';
import type { ActiveToolStep } from '../../state/types';

type Entry = { kind: 'thought'; block: ReasoningBlock } | { kind: 'tool'; step: ActiveToolStep };

/** Thoughts and calls in the order they happened: a thought follows the call it came after. */
export function workEntries(
  toolSteps: ActiveToolStep[],
  reasoningBlocks: ReasoningBlock[],
): Entry[] {
  const thoughts = reasoningBlocks.filter((b) => hasThought(b) || (!b.finished && !b.redacted));
  const ids = new Set(toolSteps.map((s) => s.callId));
  const after = (id?: string) =>
    thoughts.filter((b) => b.afterToolCallId === id).map((block) => ({ kind: 'thought' as const, block }));
  return [
    ...thoughts.filter((b) => !b.afterToolCallId).map((block) => ({ kind: 'thought' as const, block })),
    ...toolSteps.flatMap((step) => [{ kind: 'tool' as const, step }, ...after(step.callId)]),
    ...thoughts
      .filter((b) => b.afterToolCallId && !ids.has(b.afterToolCallId))
      .map((block) => ({ kind: 'thought' as const, block })),
  ];
}

export function ActivityDetails({
  reasoningBlocks = [],
  visionActivities = [],
  compactions = [],
  toolSteps,
  openStepIds,
  copiedStepId,
  setStepOpen,
  copyText,
  onThoughtToggle,
}: Pick<
  AgentActivityViewProps,
  'reasoningBlocks' | 'visionActivities' | 'compactions' | 'toolSteps'
> & {
  openStepIds: Record<string, boolean | undefined>;
  copiedStepId: string | null;
  setStepOpen: (id: string, open: boolean) => void;
  copyText: (id: string, text: string) => void;
  onThoughtToggle?: () => void;
}) {
  return (
    <Trace data-testid="agent-activity-steps" className={styles.steps}>
      {visionActivities.map((v) => (
        <div key={v.id} className={styles.vision}>
          <div>
            Image reader ({v.modelId ?? 'vision'}): {v.phase}
          </div>
          {v.answer ? <div>{v.answer}</div> : null}
        </div>
      ))}

      {compactions.map((c) => (
        <div key={c.id} className={styles.compaction}>
          <strong>Context compaction ({c.phase}):</strong>{' '}
          {c.summary ?? 'Summarizing earlier conversation turns...'}
        </div>
      ))}

      {workEntries(toolSteps, reasoningBlocks).map((item) => {
        if (item.kind === 'thought') {
          return (
            <ThoughtRow
              key={`t:${item.block.id}`}
              block={item.block}
              onToggle={onThoughtToggle}
            />
          );
        }
        const step = item.step;
        const entry = workEntry(step);
        const isStepOpen = openStepIds[step.callId] ?? step.running;
        const rowStatus =
          entry.failed || entry.warning ? 'error' : step.running ? 'running' : undefined;

        return (
          <div
            key={step.callId}
            data-testid={`tool-step-${step.callId}`}
            className={log.row}
          >
            <TraceCollapsible
              open={isStepOpen}
              onOpenChange={(next) => setStepOpen(step.callId, next)}
            >
              <TraceCollapsibleTrigger
                data-testid={`tool-step-header-${step.callId}`}
                aria-controls={`tool-detail-${step.callId}`}
                className={log.button}
              >
                <TraceLine status={rowStatus}>
                  <TraceIcon
                    aria-hidden={entry.failed || entry.warning ? undefined : 'true'}
                    className={log.icon}
                  >
                    <ToolGlyph
                      kind={entry.icon}
                      display={entry.displayIcon}
                      failed={entry.failed}
                      warning={entry.warning}
                    />
                  </TraceIcon>
                  <TraceTitle>
                    {entry.title}
                    {entry.preview ? (
                      <>
                        {entry.connector}
                        <span className={`${log.preview} ${entry.mono ? log.mono : ''}`}>
                          {entry.quoted ? '“' : ''}
                          {entry.preview}
                          {entry.quoted ? '”' : ''}
                        </span>
                      </>
                    ) : null}
                    {entry.answer ? <span className={log.answer}> → {entry.answer}</span> : null}
                  </TraceTitle>
                  {entry.description || entry.failed || entry.warning ? (
                    <TraceDescription>
                      {entry.description ? <span>{entry.description}</span> : null}
                      {entry.description && (entry.failed || entry.warning) ? (
                        <span> · </span>
                      ) : null}
                      {entry.failed || entry.warning ? (
                        <span className={entry.warning ? log.warning : log.failure}>
                          {entry.warning ? 'Denied' : 'Failed'}
                        </span>
                      ) : null}
                    </TraceDescription>
                  ) : null}
                </TraceLine>
              </TraceCollapsibleTrigger>

              <TraceCollapsibleContent id={`tool-detail-${step.callId}`} keepMounted>
                <div data-testid={`tool-step-detail-${step.callId}`} className={log.details}>
                  <ToolInspector
                    id={step.callId}
                    technical={entry.technical}
                    connectorName={entry.connectorName}
                    failed={entry.failed}
                    warning={entry.warning}
                    input={entry.input}
                    progress={entry.progress}
                    output={entry.output}
                    copiedId={copiedStepId}
                    copyText={copyText}
                  />
                </div>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </div>
        );
      })}
    </Trace>
  );
}
