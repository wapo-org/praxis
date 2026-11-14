import {describe,expect,it} from 'vitest';
import {buildSystemPrompt,FORMATTING_GUIDE} from '../conversation.js';

// WP-N2: the model is told every code block feature the web renderer reads from a fence (codeFence.ts).
describe('system prompt: code block formatting guide',()=>{
  const prompt=buildSystemPrompt({instructions:'PRODUCT'});
  it('is in every system prompt, before the product instructions',()=>{
    expect(prompt).toContain(FORMATTING_GUIDE);
    expect(prompt.indexOf('# Code blocks')).toBeLessThan(prompt.indexOf('PRODUCT'));
  });
  it.each([
    ['language', '```ts'],
    ['plain text', '```text'],
    ['file title', 'title="src/app.ts"'],
    ['line highlight', '{3,5-7}'],
    ['line numbers', 'showLineNumbers'],
    ['start line', 'startLine=40'],
    ['diff with a language', '```diff ts'],
    ['diff markers', '"+" (added), "-" (removed)'],
    ['terminal', '```terminal'],
    ['terminal prompt', '"$ "'],
    ['ansi', '```ansi'],
    ['error', '```error'],
    ['error title', 'title starting with "Error"'],
    ['collapse', 'over 20 lines'],
  ])('names the %s syntax',(_feature,syntax)=>{expect(prompt).toContain(syntax);});
  it('stays short',()=>{expect(FORMATTING_GUIDE.length).toBeLessThan(1400);});
});
