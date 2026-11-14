import {expect,it} from 'vitest';
import {runErrorCopy} from './runErrorCopy';
it('gives every run failure a plain recovery step and keeps endpoint paths out of chat',()=>{
 for(const message of ['Not available: /v1/runs','Provider HTTP 500','Invalid API key','Rate limit 429','Failed to fetch','Scripted failure']){
  expect(runErrorCopy(message)).toMatch(/try again|start a new chat/i);
  expect(runErrorCopy(message)).not.toContain('/v1/runs');
 }
 const actionable='Your provider is no longer available. Choose another model and try again.';
 expect(runErrorCopy(actionable)).toBe(actionable);
});
