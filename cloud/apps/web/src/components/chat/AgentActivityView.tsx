import { GlassSurface } from '@praxis/glass';
import React from 'react';
import { ChevronRight } from '../../lib/icons';
import { useActivityClock } from './useActivityClock';

import { ActivityDetails } from './ActivityDetails';
import type { AgentActivityViewProps } from './activityTypes';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';
export type { AgentActivityViewProps } from './activityTypes';
export const AgentActivityView: React.FC<AgentActivityViewProps> = ({
  runId,
  startedAt,
  finishedAt,
  isRunning = false,
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

  let statusColor = 'var(--paper-accent)';
  let summaryLabel = 'Completed activity';

  if (hasApproval) {
    statusColor = 'var(--paper-warn)';
    summaryLabel = `Waiting for tool approval (${pendingApprovals.length})`;
  } else if (hasElicitation) {
    statusColor = 'var(--paper-warn)';
    summaryLabel = 'Waiting for your input';
  } else if (isRunning || runningToolsCount > 0) {
    statusColor = 'var(--paper-ink-2)';
    const currentStep = toolSteps.find((s) => s.running) ?? toolSteps[toolSteps.length - 1];
    if (currentStep) {
      const stepTitle =
        currentStep.statusText ||
        currentStep.activity.presentation?.runningTitle ||
        currentStep.activity.name;
      summaryLabel = `${stepTitle}${totalToolsCount > 1 ? ` · ${totalToolsCount} steps` : ''}`;
    } else if (reasoningBlocks.some((b) => !b.finished)) {
      summaryLabel = 'Thinking...';
    } else {
      summaryLabel = 'Working...';
    }
  } else if (totalToolsCount > 0) {
    const failedCount = toolSteps.filter(
      (s) => s.completion?.status === 'failed' || s.completion?.status === 'denied',
    ).length;
    if (failedCount > 0) {
      statusColor = 'var(--paper-danger)';
      summaryLabel = `${worked} (${failedCount} failed)`;
    } else {
      statusColor = 'var(--paper-accent)';
      summaryLabel = worked;
    }
  } else if (reasoningBlocks.length > 0) {
    summaryLabel = 'Thought process';
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
    <div
      data-testid="agent-activity-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
        marginBottom: 12,
        width: '100%',
      }}
    >
      {/* Level 0: Folded / Expandable Pill Header */}
      <GlassSurface
        role="button"
        tabIndex={0}
        material="thin"
        intensity="subtle"
        radius={18}
        interactive
        data-testid="agent-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          padding: '6px 13px',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--paper-ink)',
          fontSize: 13,
          lineHeight: '18px',
          fontWeight: 500,
          maxWidth: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: statusColor,
            flexShrink: 0,
            boxShadow:
              isRunning || hasApproval || hasElicitation ? `0 0 0 3px ${statusColor}28` : 'none',
            animation:
              isRunning || runningToolsCount > 0
                ? 'praxisPulseDot 1.4s ease-in-out infinite'
                : 'none',
          }}
        />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summaryLabel}
        </span>
        <span
          aria-hidden="true"
          style={{
            fontSize: 11,
            color: 'var(--paper-ink-3)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <ChevronRight size={14} />
        </span>
      </GlassSurface>

      {/* Level 1 & Level 2: Expanded Steps + Reasoning + Vision + Compaction */}
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

      {/* Inline Pending Tool Approval Cards */}
      <ApprovalCards
        pendingApprovals={pendingApprovals}
        runId={runId}
        onResolveApproval={onResolveApproval}
      />

      {/* Inline Pending Elicitation Form Cards */}
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
