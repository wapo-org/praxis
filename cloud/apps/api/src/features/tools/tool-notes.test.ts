import {it,expect} from 'vitest';
import {connectorToolNotes} from './tool-notes.js';
import {buildSystemPrompt} from '../../conversation.js';
import type {FeatureTool} from '../../contracts.js';
const tool=(name:string,id:string,serverName:string)=>({name,description:'UNTRUSTED DESCRIPTION',source:{type:'mcp',serverId:id,serverName}} as FeatureTool);
it('groups connected tools with Swift wording, excludes descriptions and puts notes before skills',()=>{
 const tools=[tool('a','s','Search'),tool('b','s','Search'),tool('c','n','Notes')];
 const notes=connectorToolNotes(tools);expect(notes).toEqual(['Search (MCP connector): 2 tools.','Notes (MCP connector): 1 tool.','Code run with run_javascript can call connector tools as tools.<server>.<tool>(args); use it to chain or batch calls.']);
 const prompt=buildSystemPrompt({instructions:'PRODUCT',toolNotes:notes,skills:[{name:'skill',description:'skill-desc'}]});
 expect(prompt.indexOf('PRODUCT')).toBeLessThan(prompt.indexOf('Connected tools:'));expect(prompt.indexOf('Connected tools:')).toBeLessThan(prompt.indexOf('skill-desc'));expect(prompt).not.toContain('UNTRUSTED');
 tools.push(tool('d','n','Notes'));expect(prompt).toContain('Notes (MCP connector): 1 tool.');expect(connectorToolNotes([])).toEqual([]);
});
