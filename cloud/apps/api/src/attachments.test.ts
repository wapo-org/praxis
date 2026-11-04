import {describe,expect,it} from 'vitest';
import {makeTitle} from './attachments.js';
describe('makeTitle',()=>{
  it('keeps a short message as is',()=>{expect(makeTitle('Plan the launch  notes',[])).toBe('Plan the launch notes');});
  it('cuts at a word boundary with an ellipsis, never mid-word',()=>{
    const title=makeTitle('Search the workspace with tools and summarize the findings in a table',[])!;
    expect(title).toBe('Search the workspace with tools and…');
    expect(title.length).toBeLessThanOrEqual(42);
  });
  it('still cuts one very long word',()=>{
    const title=makeTitle('x'.repeat(80),[])!;
    expect(title).toBe(`${'x'.repeat(41)}…`);
  });
});
