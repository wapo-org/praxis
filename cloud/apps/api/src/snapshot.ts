import { RunSnapshotSchema, type Run, type RunEventPayload, type RunSnapshot } from '@praxis/protocol';
export function initialSnapshot(run:Run):RunSnapshot{return RunSnapshotSchema.parse({type:'run.snapshot',run,lastEventId:0,blocks:[],tools:[],pendingApprovals:[],pendingElicitations:[],messages:[]});}
export function foldSnapshot(state:RunSnapshot,event:RunEventPayload,id:number,run:Run):RunSnapshot{
 const s=structuredClone(state);s.run=run;s.lastEventId=Math.max(s.lastEventId,id);
 switch(event.type){
 case 'text.delta':case 'reasoning.delta':{
  let b=s.blocks.find(b=>b.id===event.blockId);if(!b){b={type:event.type==='text.delta'?'text':'reasoning',id:event.blockId,text:'',finished:false};s.blocks.push(b);}b.text+=event.text;break;}
 case 'text.finished':case 'reasoning.finished':{const b=s.blocks.find(b=>b.id===event.blockId);if(b)b.finished=true;break;}
 case 'tool.started':case 'tool.ready':{let t=s.tools.find(t=>t.activity.id===event.activity.id);if(!t){t={type:'tool.state',activity:event.activity,argumentsJson:'',running:false,progress:[]};s.tools.push(t);}else t.activity=event.activity;break;}
 case 'tool.arguments.delta':{const t=s.tools.find(t=>t.activity.id===event.callId);if(t)t.argumentsJson+=event.json;break;}
 case 'tool.running':{const t=s.tools.find(t=>t.activity.id===event.callId);if(t)t.running=true;break;}
 case 'tool.progress':{const t=s.tools.find(t=>t.activity.id===event.callId);if(t){t.progress.push(event);t.progress=t.progress.slice(-200);}break;}
 case 'tool.finished':{const t=s.tools.find(t=>t.activity.id===event.callId);if(t){t.running=false;t.completion=event.completion;}break;}
 case 'approval.requested':s.pendingApprovals.push(event.approval);break;
 case 'approval.resolved':s.pendingApprovals=s.pendingApprovals.filter(a=>a.id!==event.approvalId);break;
 case 'elicitation.requested':s.pendingElicitations.push(event.elicitation);break;
 case 'elicitation.resolved':s.pendingElicitations=s.pendingElicitations.filter(a=>a.id!==event.elicitationId);break;
 case 'messages.committed':for(const m of event.messages)if(!s.messages.some(x=>x.id===m.id))s.messages.push(m);break;
 case 'usage':s.usage=event.usage;break;
 case 'attempt.discarded':s.blocks=s.blocks.filter(b=>!event.blockIds.includes(b.id));s.tools=s.tools.filter(t=>!event.toolCallIds.includes(t.activity.id));break;
 case 'run.finished':s.pendingApprovals=[];s.pendingElicitations=[];for(const t of s.tools)t.running=false;break;
 }
 return s;
}
