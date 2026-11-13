// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { revealBoundaries, useSmoothText } from './smoothText';

const mounts: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => { act(() => mounts.forEach(r => r.unmount())); mounts.length=0; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('reveals bursts in words, keeps draining after stream end, and resets on a chat switch', () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn:FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const element=document.createElement('div'), root=createRoot(element); mounts.push(root);
  function Probe({text,streaming,id}:{text:string;streaming:boolean;id:string}){return <>{useSmoothText(text,streaming,id)}</>;}
  const text='Hello **reader** 👨‍👩‍👧‍👦. '.repeat(16);
  act(()=>root.render(<Probe text={text} streaming id="a"/>));
  expect(element.textContent).toBe('');
  act(()=>vi.advanceTimersByTime(400));
  const midway=element.textContent!;
  expect(midway.length).toBeGreaterThan(0);expect(midway.length).toBeLessThan(text.length);
  expect(text.startsWith(midway)).toBe(true);expect(/\s$/.test(midway)).toBe(true);
  act(()=>root.render(<Probe text={text} streaming={false} id="a"/>));
  expect(element.textContent).toBe(midway);
  act(()=>vi.advanceTimersByTime(1200));expect(element.textContent).toBe(text);
  act(()=>root.render(<Probe text="Next chat" streaming id="b"/>));expect(element.textContent).toBe('');
});
it('keeps fenced code lines and graphemes intact',()=>{
  const text='Hi 👨‍👩‍👧‍👦\n```ts\nconst x = 1;\n```\nDone';
  const parts=revealBoundaries(text).map((end,i,ends)=>text.slice(i?ends[i-1]:0,end));
  expect(parts).toContain('const x = 1;\n');expect(parts).toContain('👨‍👩‍👧‍👦\n');
  expect(parts.join('')).toBe(text);
});
it('renders history immediately and respects reduced motion',()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true}));
  const element=document.createElement('div'), root=createRoot(element);mounts.push(root);
  function Probe(){return <>{useSmoothText('All visible',true,'a')}</>;}
  act(()=>root.render(<Probe/>));expect(element.textContent).toBe('All visible');
});

it('does not starve when chunks arrive faster than animation frames',()=>{
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(performance.now()),16));
  vi.stubGlobal('cancelAnimationFrame',clearTimeout);
  const element=document.createElement('div'),root=createRoot(element);mounts.push(root);
  function Probe({text}:{text:string}){return <>{useSmoothText(text,true,'rapid')}</>;}
  for(let i=1;i<=60;i++){
    act(()=>root.render(<Probe text={'word '.repeat(i)}/>));
    act(()=>vi.advanceTimersByTime(8));
  }
  expect(element.textContent!.length).toBeGreaterThan(20);
  expect(element.textContent!.length).toBeLessThan(300);
});

it('drains an unfinished last word when its text block finishes before the run',()=>{
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(performance.now()),16));
  vi.stubGlobal('cancelAnimationFrame',clearTimeout);
  const element=document.createElement('div'),root=createRoot(element);mounts.push(root);
  function Probe({streaming}:{streaming:boolean}){return <>{useSmoothText('Ready now.',streaming,'tools')}</>;}
  act(()=>root.render(<Probe streaming/>));act(()=>vi.advanceTimersByTime(500));
  expect(element.textContent).toBe('Ready ');
  act(()=>root.render(<Probe streaming={false}/>));act(()=>vi.advanceTimersByTime(100));
  expect(element.textContent).toBe('Ready now.');
});
