import {describe,it,expect} from 'vitest';
import {advanceReveal} from './usePacedText';
import {parseMarkdownBlocks} from './markdownBlocks';
import {stableStreamingMarkdown} from './streamingMarkdown';
describe('transport-independent reveal',()=>{
  it('consumes incomplete heading and malformed fence prefixes',()=>{
    for(const text of ['### ', '```type script', '>','1. ','- ']) expect(parseMarkdownBlocks(text).length).toBeGreaterThan(0);
  });
  it('advances monotonically on grapheme boundaries without losing Unicode',()=>{
    const text='Hello 👩🏽‍💻 e\u0301 中文 שלום';
    let shown=0; const boundaries=new Set([0,...Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),p=>p.index+p.segment.length)]);
    for(let frame=0;frame<100 && shown<text.length;frame++) {const next=advanceReveal(text,shown,8.33);expect(next).toBeGreaterThanOrEqual(shown);expect(boundaries.has(next)).toBe(true);shown=next;}
    expect(shown).toBe(text.length);
  });
  it('withholds delimiter prefixes instead of flashing raw markers',()=>{
    for (const suffix of ['*','**b','*italic','`','``','~~strike','### ','$E = m']) expect(stableStreamingMarkdown('Ready\n\n'+suffix)).toBe('Ready\n\n');
    expect(stableStreamingMarkdown('* a list item\n')).toBe('* a list item\n');
  });
  it('withholds an incomplete fence, link, bold and table header',()=>{
    for(const suffix of ['```ts\nconst x=1','[Docs](htt','**bold','| Name | Value |']) expect(stableStreamingMarkdown('Ready\n\n'+suffix)).toBe('Ready\n\n');
    const table='| A | B |\n| --- | --- |\n| one | two |\n';expect(stableStreamingMarkdown(table)).toBe(table);
  });
});
