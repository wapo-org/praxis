import React from 'react';
import { ChevronRight } from '../../lib/icons';
import { ActivityDetails, stepIcon } from './ActivityDetails';
import { activityLabel, argumentSummary, stepTitle, type ActivityPhase } from './activityLine';
import type { AgentActivityViewProps } from './activityTypes';
import { ApprovalCard } from './ApprovalCards';
import { ElicitationCard } from './ElicitationCards';
import styles from './AgentActivity.module.css';

export type { AgentActivityViewProps } from './activityTypes';

/** The text plus a moving highlight. Screen readers and selection get the base copy only. */
function ShimmerText({ text }: { text: string }) {
  return (
    <span className={styles.shimmer}>
      {text}
      <span className={styles.shimmerBand} aria-hidden="true">
        <span className={styles.shimmerInk}>{text}</span>
      </span>
    </span>
  );
}

/** One expanding object, as iOS: a folded line, then a list of calls, then a call's details.
 *  What needs the user never waits behind a tap: it shows under its line, or under the header. */
export const AgentActivityView: React.FC<AgentActivityViewProps> = ({
  runId,
  startedAt,
  finishedAt,
  isRunning = false,
  isStopped = false,
  reasoningBlocks = [],
  toolSteps,
  pendingApprovals = [],
  pendingElicitations = [],
  visionActivities = [],
  compactions = [],
  onResolveApproval,
  onResolveElicitation,
}) => {
  const [expanded, setExpanded] = React.useState(false);
  const hasActivity =
    toolSteps.length > 0 ||
    reasoningBlocks.length > 0 ||
    pendingApprovals.length > 0 ||
    pendingElicitations.length > 0 ||
    visionActivities.length > 0 ||
    compactions.length > 0;
  if (!hasActivity && !isRunning && !isStopped) return null;

  // A run that ended never leaves a line pulsing, whatever its last event said.
  const steps = isRunning ? toolSteps : toolSteps.map((step) => (step.running ? { ...step, running: false } : step));
  const thoughts = isRunning ? reasoningBlocks : reasoningBlocks.map((block) => ({ ...block, finished: true }));
  const phase: ActivityPhase = isRunning ? 'running' : isStopped ? 'stopped' : 'finished';
  const label = activityLabel(phase, startedAt, finishedAt);
  const liveStep = !expanded && isRunning ? (steps.find((s) => s.running) ?? null) : null;
  const LiveIcon = liveStep ? stepIcon(liveStep) : null;
  const liveTitle = liveStep ? stepTitle(liveStep) : '';
  const liveDetail = liveStep ? argumentSummary(liveStep, liveTitle) : undefined;
  const ownerCalls = new Set(steps.map((s) => s.callId));
  const approvalCall = (approval: (typeof pendingApprovals)[number]) =>
    approval.parentCallId && ownerCalls.has(approval.parentCallId) ? approval.parentCallId : approval.callId;

  const approvalCards = (items: typeof pendingApprovals) =>
    items.map((approval) => (
      <ApprovalCard key={approval.id} approval={approval} runId={runId} onResolveApproval={onResolveApproval} />
    ));
  const elicitationCards = (items: typeof pendingElicitations) =>
    items.map((elicitation) => (
      <ElicitationCard key={elicitation.id} elicitation={elicitation} runId={runId} onResolveElicitation={onResolveElicitation} />
    ));

  const waitingFor = (callId: string) => {
    const approvals = pendingApprovals.filter((a) => approvalCall(a) === callId);
    const elicitations = pendingElicitations.filter((e) => e.callId === callId);
    if (!approvals.length && !elicitations.length) return null;
    return (
      <>
        {approvalCards(approvals)}
        {elicitationCards(elicitations)}
      </>
    );
  };
  // Folded, or a request with no line of its own yet: it sits under the header.
  const looseApprovals = expanded ? pendingApprovals.filter((a) => !ownerCalls.has(approvalCall(a))) : pendingApprovals;
  const looseElicitations = expanded
    ? pendingElicitations.filter((e) => !e.callId || !ownerCalls.has(e.callId))
    : pendingElicitations;

  return (
    <div
      data-testid="agent-activity-view"
      className={styles.activity}
      aria-label={isRunning ? 'Agent activity, currently working' : `Agent activity, ${label}`}
      role="group"
    >
      <button
        type="button"
        className={styles.header}
        data-testid="agent-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.chevron}>
          <ChevronRight size={16} />
        </span>
        <span className={styles.label}>{phase === 'finished' ? label : <ShimmerText text={label} />}</span>
        {liveStep && LiveIcon ? (
          <span className={styles.live} data-testid="agent-activity-live">
            <span aria-hidden="true">·</span>
            <span className={styles.liveIcon}>
              <LiveIcon size={16} />
            </span>
            <span className={styles.rowText}>
              {liveTitle}
              {liveDetail ? `: ${liveDetail}` : null}
            </span>
          </span>
        ) : null}
      </button>

      {expanded ? (
        <ActivityDetails
          reasoningBlocks={thoughts}
          visionActivities={visionActivities}
          compactions={compactions}
          toolSteps={steps}
          waitingFor={waitingFor}
        />
      ) : null}

      {looseApprovals.length || looseElicitations.length ? (
        <div className={styles.waiting}>
          {approvalCards(looseApprovals)}
          {elicitationCards(looseElicitations)}
        </div>
      ) : null}
    </div>
  );
};
