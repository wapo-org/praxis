import {describe,it,expect} from 'vitest';
import {workEntry} from './WorkEntry.logic';
import type {ActiveToolStep} from '../../state/types';
function row(name:string,args:unknown,output='Done.'):ActiveToolStep{return {callId:'t',activity:{type:'tool.activity',id:'t',name,source:{type:'builtin'},presentation:{type:'tool.presentation',category:'other',runningTitle:name,finishedTitle:name}},running:false,progressLines:[],argumentsJson:JSON.stringify(args),completion:{type:'tool.completion',status:'succeeded',summary:output,preview:output}};}
describe('T3 work log presentation',()=>{
  it('distinguishes paths, terminal commands, search and web',()=>{
    expect(workEntry(row('read_file',{path:'src/main.ts'}))).toMatchObject({icon:'read',mono:true,preview:'src/main.ts'});
    expect(workEntry(row('exec_command',{command:'npm test'}))).toMatchObject({icon:'command',mono:true,preview:'npm test'});
    expect(workEntry(row('search_code',{query:'reasoning'})).icon).toBe('search');
    expect(workEntry(row('web_fetch',{url:'https://example.com'})).icon).toBe('web');
  });
  it('preserves question and answer previews without hiding full output',()=>{
    expect(workEntry(row('local_elicit',{question:'Which format?'},'Markdown'))).toMatchObject({title:'Asked',preview:'Which format?',quoted:true,answer:'Markdown'});
    expect(workEntry(row('local_elicit',{question:'Which format?'},'Markdown')).body).toContain('Markdown');
    expect(workEntry(row('local_elicit',{question:'Name?'},'{"name":"Alex"}')).answer).toBe('name: Alex');
  });
  it('handles interrupted argument JSON and denied tools',()=>{
    const r=row('write_file',{});r.argumentsJson='{';r.completion!.status='denied';
    expect(workEntry(r)).toMatchObject({warning:true,failed:false,icon:'edit'});
    expect(workEntry(r).body).toContain('{');
  });
});
