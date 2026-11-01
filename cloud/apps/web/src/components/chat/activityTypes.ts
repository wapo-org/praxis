import type { Approval } from '@praxis/protocol';
import type { ActiveElicitation, ActiveToolStep } from '../../state/types';
export interface AgentActivityViewProps {
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  isRunning?: boolean;
  reasoningBlocks?: Array<{ id: string; text: string; finished: boolean }>;
  toolSteps: ActiveToolStep[];
  pendingApprovals?: Approval[];
  pendingElicitations?: ActiveElicitation[];
  visionActivities?: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    attachmentId: string;
    modelId?: string;
    question?: string;
    answer?: string;
  }>;
  compactions?: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    summary?: string;
  }>;
  onResolveApproval?: (
    runId: string,
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ) => void;
  onResolveElicitation?: (
    runId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => void;
}
