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
import { ReasoningView } from './ReasoningView';
import {workEntry} from './WorkEntry.logic';
import {WorkEntryIcon,WorkLogLine,workLogStyles as log} from './WorkLog';
import { ChevronRight } from '../../lib/icons';
import { Fold } from './Fold';
import fold from './Fold.module.css';

import styles from './Activity.module.css';
import type { AgentActivityViewProps } from './activityTypes';
export function ActivityDetails({
  reasoningBlocks = [],
  visionActivities = [],
  compactions = [],
  toolSteps,
  openStepIds,
  copiedStepId,
  toggleStepDetail,
  copyText,
}: Pick<
  AgentActivityViewProps,
  'reasoningBlocks' | 'visionActivities' | 'compactions' | 'toolSteps'
> & {
  openStepIds: Record<string, boolean>;
  copiedStepId: string | null;
  toggleStepDetail: (id: string) => void;
  copyText: (id: string, text: string) => void;
}) {
  return (
    <div data-testid="agent-activity-steps" className={styles.steps}>
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

      {toolSteps.map((step) => {
        const isStepOpen = Boolean(openStepIds[step.callId]);

        const entry=workEntry(step);

        return (
          <div
            key={step.callId}
            data-testid={`tool-step-${step.callId}`}
            className={log.row}
          >
            <button
              type="button"
              data-testid={`tool-step-header-${step.callId}`}
              aria-expanded={isStepOpen}
              aria-controls={`tool-detail-${step.callId}`}
              onClick={() => toggleStepDetail(step.callId)}
              className={log.button}
            >
              <WorkLogLine
                icon={<WorkEntryIcon kind={entry.icon} failed={entry.failed} warning={entry.warning}/>}
                trailing={<>
                  {entry.failed||entry.warning?<span className={`${log.status} ${entry.warning?log.warning:log.failure}`}>{entry.warning?'Denied':'Failed'}</span>:null}
                  <span className={`${log.chevron} ${fold.chevron}`} aria-hidden="true"><ChevronRight size={16}/></span>
                </>}
              >
                <span className={step.running?'praxis-shimmer-text':undefined}>{entry.title}</span>
                {entry.preview?<>{' '}<span className={`${log.preview} ${entry.mono?log.mono:''}`}>{entry.quoted?'“':''}{entry.preview}{entry.quoted?'”':''}</span></>:null}
                {entry.answer?<span className={log.answer}>{' '}→ {entry.answer}</span>:null}
              </WorkLogLine>
            </button>

            <Fold open={isStepOpen} id={`tool-detail-${step.callId}`}>
              <div data-testid={`tool-step-detail-${step.callId}`} className={log.details}>
                {entry.failed||entry.warning?<p className={`${log.reason} ${entry.warning?log.warning:log.failure}`}>{entry.warning?'Tool call denied':'Tool call failed'}</p>:null}
                <pre className={log.pre}>{entry.body||'No additional output.'}</pre>
                <button type="button" className={log.copy} onClick={()=>copyText(step.callId,entry.body)}>{copiedStepId===step.callId?'Copied':'Copy output'}</button>
              </div>
            </Fold>
            {reasoningBlocks.filter(b => b.afterToolCallId === step.callId).map(block => <ReasoningView key={block.id} block={block} />)}
          </div>
        );
      })}
    </div>
  );
}
