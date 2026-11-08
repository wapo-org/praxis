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
import {AgentMessageView} from '../chat/AgentMessageView';
import {AgentActivityView} from '../chat/AgentActivityView';
import type {ActiveToolStep} from '../../state/types';
import {ChevronRight} from 'lucide-react';
import {WorkEntryIcon} from '../chat/WorkLog';
export const typographySample=`# A clear plan for the next release

A good release plan makes the tradeoffs easy to understand. The response should feel calm over a long reading session, with a clear distinction between the answer and the quieter activity around it. Keep the important detail close to the decision it supports.

## Check the implementation

Read the changes in \`src/streams.ts\`, then run the targeted tests. **Keep existing behaviour** when the provider sends small deltas or a single large response. See the [streaming guide](https://example.com/streaming) for context.

### Review the evidence

1. Verify the final text and Unicode boundaries.
2. Check reasoning transitions and tool output.
3. Measure the frame budget on the headed display.

> A stable reading position is part of a readable response, not just an animation detail.

#### Validation command

\`\`\`sh
npm run typecheck
npm test -- --run
\`\`\`

| Scenario | Expected result |
| --- | --- |
| Small chunks | Steady reveal |
| One large burst | Catch up within 300 ms |
| User reads above | Keep their position |

The resulting view uses the same type family as the application, with a more generous rhythm for reading.`;
export const workSamples:ActiveToolStep[]=[
  ['read_file','Read','{"path":"packages/agent/src/streams.ts"}','Read 428 lines.'],
  ['exec_command','Ran','{"command":"npm run typecheck"}','All workspaces passed.'],
  ['search_code','Searched','{"query":"reasoning_summary_text.delta"}','Found 12 references.'],
  ['web_fetch','Opened','{"url":"https://example.com/streaming"}','Read the streaming protocol guide.'],
  ['local_elicit','Asked','{"question":"Which output format should I use?"}','Markdown, with a short table.'],
  ['write_file','Edited','{"path":"apps/web/src/components/chat/ReasoningView.tsx"}','Permission denied.'],
].map(([name,title,args,output],i)=>({callId:`sample-${i}`,activity:{type:'tool.activity',id:`sample-${i}`,name:name!,source:{type:'builtin'},traits:[],presentation:{type:'tool.presentation',category:'other',runningTitle:title!,finishedTitle:title!}},argumentsJson:args!,running:false,progressLines:[],completion:{type:'tool.completion',callId:`sample-${i}`,status:i===5?'denied':'succeeded',summary:output!,preview:output!}}));
/** Read-only reproduction of WorkLogLine/TurnFoldTimelineRow classes from the MIT T3 Code source. */
function T3SourceReference(){return <section data-testid="t3-source-reference" style={{font:'14px/1.625 var(--font-sans)',color:'var(--color-ink-2)'}}>
  <style>{'[data-testid=t3-source-reference] svg {stroke-width:2}'}</style>
  <div style={{borderBottom:'1px solid var(--color-hairline)',padding:'4px 2px 8px 0'}}><button style={{display:'flex',alignItems:'center',gap:4,padding:'0 4px',font:'inherit',color:'inherit',background:'none',border:0}}>Worked for 4.2s <ChevronRight size={14}/></button></div>
  {workSamples.map((step,i)=><div key={step.callId} style={{width:'100%',borderRadius:6,padding:'0 2px'}}><div style={{display:'flex',minHeight:24,minWidth:0,gap:6,alignItems:'center'}}><div style={{display:'flex',flex:1,minWidth:0,alignItems:'baseline',gap:6}}><span style={{position:'relative',width:24,flexShrink:0,lineHeight:0}}><span style={{display:'inline-block',width:24,height:24,verticalAlign:'calc(0.5cap - 12px)'}}><WorkEntryIcon kind={(['read','command','search','web','question','edit'] as const)[i]!}/></span></span><div style={{minWidth:0,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{step.activity.presentation?.finishedTitle} <span style={{fontFamily:i===0||i===1||i===5?'var(--font-mono)':undefined,fontSize:i===0||i===1||i===5?12:14}}>{Object.values(JSON.parse(step.argumentsJson))[0] as string}</span></div></div><span style={{display:'flex',width:16,height:16,alignItems:'center',justifyContent:'center'}}><ChevronRight size={12}/></span></div>{i===1?<pre style={{margin:'0 0 0 28px',padding:'4px 2px',maxHeight:256,overflow:'auto',whiteSpace:'pre-wrap',font:'12px/1.625 var(--font-mono)',color:'inherit'}}>Tool input{`\n{"command":"npm run typecheck"}\n\nAll workspaces passed.`}</pre>:null}</div>)}

</section>}
export function H2DesignLabPage(){return <main style={{padding:32,color:'var(--color-ink)',height:'100dvh',overflow:'auto'}}>
  <h1>H2 reading and work log review</h1>
  <section data-testid="typography-options" style={{display:'grid',gridTemplateColumns:'repeat(3,720px)',gap:32,alignItems:'start'}}>
    {[{label:'A · Compact · 14 / 20',size:'var(--text-md)',leading:'var(--leading-md)',font:'var(--font-sans)'},{label:'B · Reading · 16 / 26 · selected',size:'var(--text-lg)',leading:'var(--leading-lg)',font:'var(--font-sans)'},{label:'C · Editorial · 19 / 32',size:'var(--text-xl)',leading:'var(--leading-2xl)',font:'var(--font-display)'}].map(option=><article key={option.label} style={{'--response-size':option.size,'--response-leading':option.leading,'--response-font':option.font} as React.CSSProperties}><h2 style={{font:'14px/20px var(--font-sans)',marginBottom:24}}>{option.label}</h2><AgentMessageView text={typographySample}/></article>)}
  </section>
  <h2>T3 Code source reproduction and Praxis port</h2>
  <section data-testid="work-log-comparison" style={{display:'grid',gridTemplateColumns:'720px 720px',gap:32}}>
    <article><h3>T3 source · WorkLog + TurnFold</h3><T3SourceReference/></article>
    <article><h3>Praxis · same structure, semantic type and colour tokens</h3><AgentActivityView runId="design-sample" startedAt="2026-11-08T12:00:00.000Z" finishedAt="2026-11-08T12:00:04.200Z" toolSteps={workSamples}/></article>
  </section>
</main>}
