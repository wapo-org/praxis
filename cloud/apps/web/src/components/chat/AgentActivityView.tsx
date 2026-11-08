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
import { SNAP, SPRING } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { ChevronRight } from '../../lib/icons';
import { glideFollowing } from './chatMotion';
import {
  resolveTurnStartIso,
  stoppedLabel,
  useActivityClock,
  WorkingTimer,
} from './useActivityClock';

import styles from './Activity.module.css';
import { ReasoningView } from './ReasoningView';
import { ActivityDetails } from './ActivityDetails';
import type { AgentActivityViewProps } from './activityTypes';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';

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

  // Preserve the disclosure header's scroll anchor when toggling, while FLIP-gliding following siblings.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const height = React.useRef(0);
  const anchorTopRef = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (anchorTopRef.current !== null) {
      const viewport = el.closest<HTMLElement>('[data-testid="chat-scroll-viewport"]');
      if (viewport) {
        const deltaTop = el.getBoundingClientRect().top - anchorTopRef.current;
        if (Math.abs(deltaTop) > 1) viewport.scrollTop += deltaTop;
      }
      anchorTopRef.current = null;
    }
    const next = el.offsetHeight;
    if (height.current) glideFollowing(el, next - height.current);
    height.current = next;
  }, [expanded, openStepIds]);

  const effectiveStart = resolveTurnStartIso(startedAt, finishedAt, promptStartedAt);
  const worked = useActivityClock(isRunning, startedAt, finishedAt, promptStartedAt);
  const hasActivity =
    toolSteps.length > 0 ||
    reasoningBlocks.length > 0 ||
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
    label = 'Working…';
    const currentStep = toolSteps.find((s) => s.running) ?? toolSteps[toolSteps.length - 1];
    if (currentStep) {
      subLine =
        currentStep.statusText ||
        currentStep.activity.presentation?.runningTitle ||
        currentStep.activity.name;
      if (totalToolsCount > 1) subLine = `${subLine} · ${totalToolsCount} steps`;
    } else if (reasoningBlocks.some((b) => !b.finished)) {
      subLine = 'Thinking…';
    }
  } else if (stopped) {
    label = stoppedLabel(startedAt, finishedAt, promptStartedAt);
  } else if (totalToolsCount > 0 || startedAt || finishedAt) {
    label = worked;
  } else if (reasoningBlocks.length > 0) {
    label = 'Thought process';
  }

  const toggleExpanded = () => {
    if (rootRef.current) anchorTopRef.current = rootRef.current.getBoundingClientRect().top;
    setExpanded((v) => !v);
  };

  const toggleStepDetail = (callId: string) => {
    if (rootRef.current) anchorTopRef.current = rootRef.current.getBoundingClientRect().top;
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
      {reasoningBlocks.filter(b => !b.afterToolCallId).map(block => <ReasoningView key={block.id} block={block} />)}
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
        <motion.span
          className={styles.chevron}
          aria-hidden="true"
          initial={false}
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={SNAP}
        >
          <ChevronRight size={16} />
        </motion.span>

      </button></div>

      {/* Level 2: one line per call; level 3: details inside the line. */}
      {expanded && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
          <ActivityDetails
            reasoningBlocks={reasoningBlocks.filter(b => b.afterToolCallId)}
            visionActivities={visionActivities}
            compactions={compactions}
            toolSteps={toolSteps}
            openStepIds={openStepIds}
            copiedStepId={copiedStepId}
            toggleStepDetail={toggleStepDetail}
            copyText={copyText}
          />
        </motion.div>
      )}

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
