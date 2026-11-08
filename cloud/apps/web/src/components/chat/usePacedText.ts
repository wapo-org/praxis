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
export function usePacedText(text: string, live: boolean) {
  const [visible, setVisible] = React.useState(live ? '' : text);
  const displayed = React.useRef(live ? '' : text);
  const source = React.useRef(text); source.current = text;
  const wasLive = React.useRef(live); if (live) wasLive.current = true;
  React.useEffect(() => {
    if (!wasLive.current) { displayed.current=text; setVisible(text); return; }
    let frame = 0, last = performance.now(), started = last;
    let offset = source.current.startsWith(displayed.current) ? displayed.current.length : 0;
    const tick = (now: number) => {
      const dt = Math.min(40, Math.max(1, now - last)); last = now;
      const current = source.current;
      offset = now - started > 240 ? current.length : advanceReveal(current, offset, dt);
      // A JSON delta may end on a high surrogate; wait for the low surrogate.
      if (live && /[\uD800-\uDBFF]$/.test(current.slice(0,offset))) offset--;
      displayed.current=current.slice(0, offset);
      setVisible(displayed.current);
      if(offset < current.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, text]);
  return wasLive.current ? visible : text;
}
