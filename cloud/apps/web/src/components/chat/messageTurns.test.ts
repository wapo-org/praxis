import {describe,it,expect} from 'vitest';
import {MessageSchema} from '@praxis/protocol';
import {messageTurns} from './messageTurns';
const msg=(id:string,role:'user'|'assistant',runId?:string)=>MessageSchema.parse({type:'message',id,role,runId,chatId:'chat',parts:[{type:'text',text:id}],createdAt:'2026-11-08T12:00:00.000Z',updatedAt:'2026-11-08T12:00:01.000Z'});
describe('rendered assistant turns',()=>{
 it('keeps model/tool/reasoning order in one work disclosure without mutating provider history',()=>{
  const messages=[msg('u','user'),msg('a','assistant','run'),msg('t','assistant','run'),msg('b','assistant','run')];
  messages[2]!.role='user';messages[2]!.parts[0]!.type='toolResult';messages[2]!.parts[0]!.callId='tool';
  const turns=messageTurns(messages);expect(turns).toHaveLength(2);expect(turns[1]?.parts.map(p=>p.text)).toEqual(['a','t','b']);expect(turns[1]?.id).toBe('a');expect(messages[1]?.parts).toHaveLength(1);expect(messages[2]?.role).toBe('user');
 });
 it('does not merge across prompts, runs or ungrouped legacy messages',()=>{
  const messages=[msg('a','assistant','r1'),msg('b','assistant','r2'),msg('u','user'),msg('c','assistant','r2'),msg('legacy','assistant')];expect(messageTurns(messages)).toEqual(messages);
 });
});
