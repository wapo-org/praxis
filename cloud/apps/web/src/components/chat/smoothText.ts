import React from 'react';

/** A word (or a fenced code line) is the smallest reveal. Never cut a UTF-16 pair or a markdown delimiter. */
export function revealBoundaries(text: string): number[] {
  const ends: number[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker) {
      ends.push(offset + line.length);
      if (marker) fence = fence && marker[0] === fence[0] && marker.length >= fence.length ? undefined : fence ?? marker;
    } else {
      for (const word of line.matchAll(/\S+\s*|\s+/g)) ends.push(offset + word.index! + word[0].length);
    }
    offset += line.length;
  }
  return ends;
}

/** Retain the burst rate until caught up: a backlog drains over about 2.5 s live, 2 s after the end. */
export function useSmoothText(text: string, streaming: boolean, identity?: string): string {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [state, setState] = React.useState(() => ({ identity, text: streaming && !reduced ? '' : text }));
  const cursor = React.useRef({ identity, text: state.text, credit: 0, rate: 60 });
  const frameRef = React.useRef(0);
  const latest = React.useRef({text, identity, ends: [] as number[]});
  const ends = React.useMemo(() => {
    const boundaries = revealBoundaries(text);
    return streaming && !/\s$/.test(text) ? boundaries.filter(end => end < text.length) : boundaries;
  }, [text, streaming]);
  React.useLayoutEffect(() => {
    const c = cursor.current;
    latest.current = {text, identity, ends};
    if (c.identity !== identity || !text.startsWith(c.text)) {
      c.identity = identity; c.text = streaming && !reduced ? '' : text; c.credit = 0; c.rate = 60;
      setState({ identity, text: c.text });
    }
    if (reduced) { c.text = text; setState({ identity, text }); return; }
    c.rate = Math.max(streaming ? 60 : 300, c.rate, (text.length - c.text.length) / (streaming ? 2.5 : 2));
    if (frameRef.current) return;
    let previous = performance.now();
    const tick = (now: number) => {
      frameRef.current = 0;
      const { text, identity, ends } = latest.current;
      c.credit += c.rate * Math.min(64, now - previous) / 1000;
      previous = now;
      let end = c.text.length;
      for (const boundary of ends) {
        if (boundary <= end) continue;
        if (boundary - c.text.length > c.credit) break;
        end = boundary;
      }
      if (end > c.text.length) {
        c.credit -= end - c.text.length; c.text = text.slice(0, end);
        setState({ identity, text: c.text });
      }
      if (c.text.length < text.length) frameRef.current = requestAnimationFrame(tick);
      else { c.credit = 0; c.rate = 60; }
    };
    if (c.text.length < text.length) frameRef.current = requestAnimationFrame(tick);
  }, [text, streaming, identity, reduced, ends]);
  React.useLayoutEffect(() => () => { cancelAnimationFrame(frameRef.current); frameRef.current = 0; }, []);
  return state.identity === identity && text.startsWith(state.text) ? state.text : streaming && !reduced ? '' : text;
}
