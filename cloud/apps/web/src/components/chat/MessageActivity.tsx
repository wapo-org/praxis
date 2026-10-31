import React from 'react';
import type { Run, Message } from '@praxis/protocol';
import type { ActiveToolStep } from '../../state/store';
import { apiClient } from '../../lib/api';
import { AgentActivityView } from './AgentActivityView';
export function MessageActivity({ message, steps, liveRun, liveSteps }: { message: Message; steps: ActiveToolStep[]; liveRun?: Run; liveSteps?: ActiveToolStep[] }) {
  const [run, setRun] = React.useState<Run | undefined>(liveRun);
  const [recoveredSteps, setRecoveredSteps] = React.useState<ActiveToolStep[] | undefined>();
  React.useEffect(() => {
    if (liveRun) { setRun(liveRun); return; }
    if (!message.runId) return;
    let active = true;
    void apiClient.getRunSnapshot(message.runId).then(value => { if (active) {
      setRun(value.run);
      setRecoveredSteps(value.tools.map(tool => ({ callId: tool.activity.id, activity: tool.activity, argumentsJson: tool.argumentsJson, running: false, progressLines: [], completion: tool.completion })));
    } }).catch(() => {});
    return () => { active = false; };
  }, [message.runId, liveRun]);
  return <AgentActivityView startedAt={run?.createdAt} finishedAt={run?.updatedAt} isRunning={false} toolSteps={liveSteps ?? recoveredSteps ?? steps}
    reasoningBlocks={message.parts.filter(p => p.type === 'reasoning').map((p, i) => ({ id: `${message.id}-${i}`, text: p.text ?? '', finished: true }))} />;
}
