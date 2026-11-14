import {expect,it} from 'vitest';
import {decideTool} from './policy.js';
import type {ToolSpec} from '@praxis/protocol';
it.each(['builtin','skill','server','javascript','mcp'] as const)('Execute never asks for approval for %s writes',type=>{
 const spec={type:'tool.spec',name:'write',description:'Write',inputSchema:{type:'object'},source:{type},traits:['destructive','openWorld']} as ToolSpec;
 expect(decideTool(spec,'build',{alwaysAllow:[],trustedSources:[]},'key').decision).toBe('allow');
});
