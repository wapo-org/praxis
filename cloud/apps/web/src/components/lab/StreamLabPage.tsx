import React from 'react';
import { StreamSimOptionsSchema, type StreamSimOptions, type RunBlock, type RunSnapshot, type RunEvent } from '@praxis/protocol';
import { apiClient } from '../../lib/api';
import { subscribeRunEvents } from '../../lib/sse';
import { ReasoningView } from '../chat/ReasoningView';
import {useStreamAnchor} from '../chat/useStreamAnchor';
import { AgentMessageView } from '../chat/AgentMessageView';
/** Uses the real local runner, SSE log and snapshot recovery. Never selects a network provider. */
export function StreamLabPage() {
  const [options, setOptions] = React.useState(StreamSimOptionsSchema.parse({}));
  const [blocks, setBlocks] = React.useState<RunBlock[]>([]);
  const [status, setStatus] = React.useState('idle');
  const [error, setError] = React.useState('');
  const unsub = React.useRef<(() => void) | undefined>(undefined);
  const runId = React.useRef('');
  const viewport = React.useRef<HTMLDivElement>(null);
  const content=React.useRef<HTMLDivElement>(null);
  const {onScroll}=useStreamAnchor(viewport,content,'stream-lab');
  const recover = (s: RunSnapshot) => { setBlocks(s.blocks); setStatus(s.run.status); };
  const follow = (id: string, after = 0) => {
    runId.current = id;
    unsub.current?.();
    unsub.current = subscribeRunEvents(apiClient, id, after, {
      onSnapshotRecovered: recover,
      onError: e => setError(String(e)),
      onEvent: ({event, createdAt}: RunEvent) => {
        if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
          setBlocks(old => {
            const prev = old.find(b => b.id === event.blockId);
            const b: RunBlock = {type: event.type === 'text.delta' ? 'text' : 'reasoning',
              ...prev, id:event.blockId, text:(prev?.text ?? '') + event.text, finished:false,
              startedAt:prev?.startedAt ?? createdAt,
              ...(event.type === 'reasoning.delta' ? {shape:event.shape, redacted:event.redacted} : {})};
            return prev ? old.map(x => x.id === b.id ? b : x) : [...old, b];
          });
        }
        if (event.type === 'text.finished' || event.type === 'reasoning.finished') setBlocks(old => old.map(b => b.id === event.blockId ? {...b, finished:true, finishedAt:createdAt, durationMs:Math.max(0, Date.parse(createdAt)-Date.parse(b.startedAt ?? createdAt))} : b));
        if (event.type === 'run.finished') {
          setStatus(event.outcome === 'cancelled' ? 'cancelled' : event.outcome === 'failed' ? 'failed' : 'completed');
          setBlocks(old => old.map(b => ({...b,finished:true,finishedAt:b.finishedAt ?? createdAt})));
          if(event.message)setError(event.message);
        }
      },
      onComplete: () => { void apiClient.getRunSnapshot(id).then(recover); },
    });
  };
  React.useEffect(() => {
    const id = sessionStorage.getItem('stream-lab-run');
    if (id) void apiClient.getRunSnapshot(id).then(s => { recover(s); if (!['completed','failed','cancelled'].includes(s.run.status)) follow(id,s.lastEventId); });
    return () => unsub.current?.();
  }, []);
  const start = async () => {
    unsub.current?.(); setBlocks([]); setError(''); setStatus('running');
    const chat = await apiClient.createChat({title:'Stream simulator'});
    const response = await fetch(`${apiClient.getBaseUrl()}/v1/runs`, {method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${await apiClient.freshToken()}`},body:JSON.stringify({type:'run.start',chatId:chat.id,text:'Streaming boundary test',script:'streamSim',streamSim:options})});
    if (!response.ok) { setError(await response.text()); setStatus('failed'); return; }
    const run = await response.json(); sessionStorage.setItem('stream-lab-run',run.id); follow(run.id);
  };
  return <main style={{maxWidth:860,margin:'32px auto',padding:24,color:'var(--paper-ink)'}}>
    <h1>Stream simulator</h1>
    <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
      {Object.entries(StreamSimOptionsSchema.shape).map(([key, schema]) => <label key={key}>{key} <select aria-label={key} value={options[key as keyof StreamSimOptions]} onChange={e => setOptions(old => ({...old,[key]:e.target.value}))}>
        {schema.unwrap().options.map(value => <option key={value}>{value}</option>)}
      </select></label>)}
      <button onClick={() => void start().catch(e => setError(String(e)))}>Start stream</button>
      <button onClick={() => void apiClient.cancelRun(runId.current)}>Stop stream</button>
      <button onClick={() => window.location.reload()}>Reload and resume</button>
    </div>
    <p role="status" data-testid="stream-status">{status}</p>{error && <p role="alert">{error}</p>}
    <div ref={viewport} data-testid="stream-viewport" style={{height:'65vh',overflow:'auto',overflowAnchor:'none'}} onScroll={onScroll}>
      <div ref={content}>{blocks.map(b => b.type === 'reasoning' ? <ReasoningView key={b.id} block={b}/> : <AgentMessageView key={b.id} text={b.text} isStreaming={!b.finished && status === 'running'}/>)}</div>
    </div>
    <output hidden data-testid="stream-final">{blocks.filter(b => b.type==='text').map(b=>b.text).join('')}</output>
  </main>;
}
