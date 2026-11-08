import React from 'react';
/** Drain a transport burst within 240ms, using grapheme boundaries (never half an emoji). */
export function advanceReveal(text: string, shown: number, dt: number): number {
  const pending = text.length - shown;
  if (pending <= 0) return text.length;
  const target = Math.min(text.length, shown + Math.max(1, Math.ceil(pending * Math.min(1, dt / 70))));
  // Segment only the pending tail; no layout reads or DOM work in the clock.
  let boundary = shown;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(shown))) {
    const end = shown + part.index + part.segment.length;
    // A trailing cluster may continue in the next transport delta. Leave it until another arrives.
    if (end > target) { if (boundary === shown) boundary = end; break; }
    boundary = end;
  }
  return boundary;
}
export interface RevealSegment {id:string;text:string}
const revealCache = new Map<string,string>();
function cachedPrefix(text:string, segments:RevealSegment[]) {
  let result='';
  for(const segment of segments) {
    const cached=revealCache.get(segment.id);
    if(cached===undefined)break;
    const part=segment.text.startsWith(cached)?cached:cached.startsWith(segment.text)?segment.text:'';
    result+=(result?'\n\n':'')+part;
    if(part.length<segment.text.length)break;
  }
  return text.startsWith(result)?result:'';
}
export function usePacedText(text: string, live: boolean, options?: {animateArrival?:boolean;segments?:RevealSegment[]}) {
  const pace=live || !!options?.animateArrival;
  const [visible,setVisible]=React.useState(()=>pace?cachedPrefix(text,options?.segments??[]):text);
  const displayed=React.useRef(visible);
  const source=React.useRef(text);source.current=text;
  const segments=React.useRef(options?.segments);segments.current=options?.segments;
  const wasLive=React.useRef(pace);if(pace)wasLive.current=true;
  React.useEffect(()=>{
    if(!wasLive.current){displayed.current=text;setVisible(text);return;}
    let frame=0,last=performance.now(),started=last;
    let offset=source.current.startsWith(displayed.current)?displayed.current.length:0;
    const tick=(now:number)=>{
      const dt=Math.min(40,Math.max(1,now-last));last=now;
      const current=source.current;
      offset=now-started>240?current.length:advanceReveal(current,offset,dt);
      if(live&&/[\uD800-\uDBFF]$/.test(current.slice(0,offset)))offset--;
      displayed.current=current.slice(0,offset);
      let start=0;
      for(const segment of segments.current??[]){
        if(offset>start)revealCache.set(segment.id,displayed.current.slice(start,start+segment.text.length));
        start+=segment.text.length+2;
      }
      while(revealCache.size>500)revealCache.delete(revealCache.keys().next().value!);
      setVisible(displayed.current);
      if(offset<current.length)frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(frame);
  },[pace,live,text]);
  return wasLive.current?visible:text;
}
