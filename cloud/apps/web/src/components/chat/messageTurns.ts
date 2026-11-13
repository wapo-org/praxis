import type {Message} from '@praxis/protocol';
const isToolResult=(message:Message)=>message.parts.length>0&&message.parts.every(part=>part.type==='toolResult');
const isPrompt=(message:Message)=>message.role==='user'&&!isToolResult(message);
/** When each part's source message was committed. Merging a turn keeps part identity, so saved timelines can still time tool calls. */
export const partCommittedAt=new WeakMap<object,string>();
/** Wire tool results use role:user; they are not human prompts or separate visible turns. */
export function messageTurns(messages:Message[]):Message[] {
  const turns:Message[]=[];
  for(const message of messages){
    for(const part of message.parts)if(!partCommittedAt.has(part))partCommittedAt.set(part,message.createdAt);
    const previous=turns.at(-1);
    if(!isPrompt(message)&&message.runId&&previous&&!isPrompt(previous)&&previous.runId===message.runId){
      turns[turns.length-1]={...previous,role:'assistant',parts:[...previous.parts,...message.parts],updatedAt:message.updatedAt};
    }else turns.push(isToolResult(message)?{...message,role:'assistant'}:message);
  }
  return turns;
}
