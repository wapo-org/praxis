import React from 'react';
import { ChevronRight } from '../../lib/icons';
import { stoppedLabel, useActivityClock } from './useActivityClock';

import styles from './Activity.module.css';
import { ActivityDetails } from './ActivityDetails';
import type { AgentActivityViewProps } from './activityTypes';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';

export type { AgentActivityViewProps } from './activityTypes';

/**
 * iOS parity (PraxisChat AgentActivity.swift, spec §9): one plain line,
 * folded by default. A small chevron on the left, then muted 13 px medium
 * text — "Currently working…" (shimmer) while running, "Worked for Ns"
 * when done, "Stopped after Ns" when the run was cancelled or failed.
 * No pill, background, border, dot or shadow. Approvals and questions
 * always show under the header, even folded.
 */
export const AgentActivityView: React.FC<AgentActivityViewProps & { runStatus?: string }> = ({
  runId,
  startedAt,
  finishedAt,
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

  const worked = useActivityClock(isRunning, startedAt, finishedAt);
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
  const stopped =
    !isRunning && (runStatus === 'cancelled' || runStatus === 'failed' || runStatus === 'refused');

  let label = worked;
  let subLine = '';
  if (hasApproval) {
    label = `Waiting for tool approval (${pendingApprovals.length})`;
  } else if (hasElicitation) {
    label = 'Waiting for your input';
  } else if (isRunning || runningToolsCount > 0) {
    label = 'Currently working…';
    const currentStep = toolSteps.find((s) => s.running) ?? toolSteps[toolSteps.length - 1];
    if (currentStep) {
      subLine = currentStep.statusText ||
        currentStep.activity.presentation?.runningTitle ||
        currentStep.activity.name;
      if (totalToolsCount > 1) subLine = `${subLine} · ${totalToolsCount} steps`;
    } else if (reasoningBlocks.some((b) => !b.finished)) {
      subLine = 'Thinking…';
    }
  } else if (stopped) {
    label = stoppedLabel(startedAt, finishedAt);
  } else if (totalToolsCount > 0) {
    const failedCount = toolSteps.filter(
      (s) => s.completion?.status === 'failed' || s.completion?.status === 'denied',
    ).length;
    if (failedCount > 0) label = `${worked} (${failedCount} failed)`;
  } else if (reasoningBlocks.length > 0) {
    label = 'Thought process';
  }

  const toggleStepDetail = (callId: string) => {
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
    <div data-testid="agent-activity-view" className={styles.root}>
      {/* Level 1: plain disclosure header, like iOS. */}
      <button
        type="button"
        data-testid="agent-activity-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide agent activity' : 'Show agent activity'}
        onClick={() => setExpanded((v) => !v)}
        className={styles.header}
      >
        <span className={styles.chevron} data-open={expanded} aria-hidden="true">
          <ChevronRight size={16} />
        </span>
        <span className={`${styles.label} ${label === 'Currently working…' ? 'praxis-shimmer-text' : ''}`}>
          {label}
        </span>
        {subLine ? <span className={styles.detail}>{subLine}</span> : null}
      </button>

      {/* Level 2: one line per call; level 3: details inside the line. */}
      {expanded && (
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
