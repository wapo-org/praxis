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
import React from 'react';
import { ChevronRight } from '../../lib/icons';
import { Fold, holdScrollPosition } from './Fold';
import foldStyles from './Fold.module.css';
import {
  resolveTurnStartIso,
  stoppedLabel,
  useActivityClock,
  WorkingTimer,
} from './useActivityClock';

import styles from './Activity.module.css';
import { ReasoningBody, hasThought, reasoningLabel, type ReasoningBlock } from './ReasoningView';
import reasoningStyles from './ReasoningView.module.css';
import { computeElapsedMs } from './useActivityClock';
import { ActivityDetails } from './ActivityDetails';
import type { AgentActivityViewProps } from './activityTypes';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';
import { humanLabel, toolDisplay } from './toolDisplay';

export type { AgentActivityViewProps } from './activityTypes';

/**
 * Turn fold / work disclosure row (ported from t3code TurnFoldTimelineRow &
 * WorkingTimelineRow + Praxis iOS AgentActivity.swift): one plain line,
 * folded by default. Chevron + muted 13 px medium tabular-nums label —
 * "Working…" (shimmer + live timer) while running, "Worked for <duration>"
 * when done, "Stopped after <duration>" when cancelled or failed.
 * Approvals and questions always show under the header, even folded.
 */
export const AgentActivityView: React.FC<AgentActivityViewProps & { runStatus?: string }> = ({
  runId,
  startedAt,
  finishedAt,
  promptStartedAt,
  isRunning = false,
  timelineGroup = false,
  runStatus,
  reasoningBlocks = [],
  toolSteps,
  pendingApprovals = [],
  pendingElicitations = [],
  visionActivities = [],
  compactions = [],
  onResolveApproval,
  onResolveElicitation,
}) => {
  const [expanded, setExpanded] = React.useState<boolean>(false);
  const [openStepIds, setOpenStepIds] = React.useState<Record<string, boolean>>({});
  const [copiedStepId, setCopiedStepId] = React.useState<string | null>(null);
  const [elicitationValues, setElicitationValues] = React.useState<
    Record<string, Record<string, unknown>>
  >({});

  // Match t3code: an interrupted/cancelled run opens its fold; a newer run closes the previous run's.
  const observedRunRef = React.useRef<{ runId?: string; status?: string }>({
    runId,
    status: isRunning ? 'running' : runStatus,
  });
  React.useEffect(() => {
    const prev = observedRunRef.current;
    const currentStatus = isRunning ? 'running' : runStatus;
    if (prev.runId !== undefined && runId !== undefined) {
      if (prev.runId === runId) {
        if (prev.status === 'running' && (currentStatus === 'cancelled' || currentStatus === 'interrupted')) {
          setExpanded(true);
        }
      } else {
        setExpanded(false);
      }
    }
    observedRunRef.current = { runId, status: currentStatus };
  }, [runId, isRunning, runStatus]);

  // Preserve the disclosure header's scroll position when toggling; the fold's height carries what follows.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const anchorTopRef = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || anchorTopRef.current === null) return;
    const viewport = el.closest<HTMLElement>('[data-testid="chat-scroll-viewport"]');
    if (viewport) {
      const deltaTop = el.getBoundingClientRect().top - anchorTopRef.current;
      if (Math.abs(deltaTop) > 1) viewport.scrollTop += deltaTop;
    }
    anchorTopRef.current = null;
  }, [expanded, openStepIds]);

  const effectiveStart = resolveTurnStartIso(startedAt, finishedAt, promptStartedAt);
  const worked = useActivityClock(isRunning, startedAt, finishedAt, promptStartedAt);
  // A thought with nothing to show is not activity (K-ref/07): no row, no chevron, no group.
  const thoughts = reasoningBlocks.filter(hasThought);
  // While a thought streams and the group is folded, it shows under the header; when it ends it folds in place.
  const liveThought = reasoningBlocks.find((b) => !b.finished && hasThought(b));
  const peekRef = React.useRef<ReasoningBlock | undefined>(undefined);
  if (liveThought) peekRef.current = liveThought;
  const peekBlock = liveThought ?? (peekRef.current ? reasoningBlocks.find((b) => b.id === peekRef.current!.id) ?? peekRef.current : undefined);
  const hasActivity =
    toolSteps.length > 0 ||
    thoughts.length > 0 ||
    pendingApprovals.length > 0 ||
    pendingElicitations.length > 0 ||
    visionActivities.length > 0 ||
    compactions.length > 0;

  if (!hasActivity && !isRunning) {
    return null;
  }

  const runningToolsCount = toolSteps.filter((t) => t.running).length;
  const totalToolsCount = toolSteps.length;
  const hasApproval = pendingApprovals.length > 0;
  const hasElicitation = pendingElicitations.length > 0;
  const activelyWorking = !hasApproval && !hasElicitation && (isRunning || runningToolsCount > 0);
  const stopped =
    !isRunning && (runStatus === 'cancelled' || runStatus === 'failed' || runStatus === 'refused');

  let label = worked;
  let subLine = '';
  if (hasApproval) {
    label = `Waiting for tool approval (${pendingApprovals.length})`;
  } else if (hasElicitation) {
    label = 'Waiting for your input';
  } else if (activelyWorking) {
    label = 'Working';
    const currentStep = toolSteps.find((s) => s.running) ?? toolSteps[toolSteps.length - 1];
    if (currentStep) {
      const display = toolDisplay(currentStep);
      const rawStatus = currentStep.statusText?.trim();
      const humanStatus =
        rawStatus &&
        !rawStatus.includes(currentStep.activity.name) &&
        !/mcp__|_[0-9a-f]{8,}|[0-9]{9,}/i.test(rawStatus)
          ? humanLabel(rawStatus)
          : '';
      subLine =
        humanStatus ||
        (display.title === 'Searching the web' && display.detail
          ? `Searching the web for '${display.detail}'`
          : [display.title, display.detail].filter(Boolean).join(' · '));
      if (totalToolsCount > 1) subLine = `${subLine} · ${totalToolsCount} steps`;
    } else if (liveThought) {
      // The thought streams in the peek under the row (L-ref/05): the header does not repeat it.
    } else if (reasoningBlocks.some((b) => !b.finished)) {
      subLine = 'Thinking…';
    }
  } else if (stopped) {
    label = stoppedLabel(startedAt, finishedAt, promptStartedAt);
  } else if (!timelineGroup && totalToolsCount === 0 && thoughts.length > 0 && visionActivities.length === 0 && compactions.length === 0) {
    // Standalone non-timeline turn that only reasoned: say so, with the time it spent reasoning.
    const known = thoughts.map((b) => b.durationMs ?? computeElapsedMs(b.startedAt, b.finishedAt)).filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
    label = reasoningLabel(false, known.length ? known.reduce((a, b) => a + b, 0) : computeElapsedMs(effectiveStart, finishedAt));
  } else if (totalToolsCount > 0 || startedAt || finishedAt) {
    label = worked;
  }

  const toggleExpanded = () => {
    if (rootRef.current) anchorTopRef.current = rootRef.current.getBoundingClientRect().top;
    holdScrollPosition(rootRef.current);
    setExpanded((v) => !v);
  };

  const toggleStepDetail = (callId: string) => {
    if (rootRef.current) anchorTopRef.current = rootRef.current.getBoundingClientRect().top;
    holdScrollPosition(rootRef.current);
    setOpenStepIds((prev) => ({ ...prev, [callId]: !prev[callId] }));
  };

  const copyText = (id: string, text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedStepId(id);
    setTimeout(() => {
      setCopiedStepId((curr) => (curr === id ? null : curr));
    }, 1500);
  };

  return (
    <div ref={rootRef} data-testid="agent-activity-view" className={styles.root}>
      {/* Level 1: t3code turn-fold disclosure header. */}
      <div className={styles.groupBar}><button
        type="button"
        data-testid="agent-activity-toggle"
        data-scroll-anchor-ignore=""
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide agent activity' : 'Show agent activity'}
        onClick={toggleExpanded}
        className={styles.header}
      >
        <span className={`${styles.label} ${activelyWorking ? 'praxis-shimmer-text' : ''}`}>
          {label}
        </span>
        {activelyWorking && effectiveStart ? <WorkingTimer startedAt={effectiveStart} /> : null}
        {subLine ? <span className={styles.detail}>{subLine}</span> : null}
        <span className={`${styles.chevron} ${foldStyles.chevron}`} aria-hidden="true">
          <ChevronRight size={16} />
        </span>

      </button></div>

      {/* The live thought, while the group is folded: the text streams here and folds away when it ends. */}
      <Fold open={!expanded && !!liveThought} testId="agent-activity-peek">
        {peekBlock ? <div className={reasoningStyles.peek} data-testid="reasoning-peek"><ReasoningBody block={peekBlock} capped /></div> : null}
      </Fold>
      <span className={reasoningStyles.sr} role="status" aria-live="polite">{liveThought ? 'Thinking' : ''}</span>

      {/* Level 2: one line per call; level 3: details inside the line. */}
      <Fold open={expanded} testId="agent-activity-fold">
          <ActivityDetails
            reasoningBlocks={reasoningBlocks}
            visionActivities={visionActivities}
            compactions={compactions}
            toolSteps={toolSteps}
            openStepIds={openStepIds}
            copiedStepId={copiedStepId}
            toggleStepDetail={toggleStepDetail}
            copyText={copyText}
          />
      </Fold>

      {/* Always visible, even folded: what needs the user. */}
      <ApprovalCards
        pendingApprovals={pendingApprovals}
        runId={runId}
        onResolveApproval={onResolveApproval}
      />

      <ElicitationCards
        pendingElicitations={pendingElicitations}
        runId={runId}
        onResolveElicitation={onResolveElicitation}
        elicitationValues={elicitationValues}
        setElicitationValues={setElicitationValues}
      />
    </div>
  );
};
