import React from 'react';
/** Follow rendered height changes, including paced reveal and reasoning folds, only while pinned. */
export function useStreamAnchor(viewport:React.RefObject<HTMLElement|null>,content:React.RefObject<HTMLElement|null>) {
  const pinned=React.useRef(true);
  const onScroll=React.useCallback(()=>{
    const el=viewport.current;
    if(el)pinned.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  },[viewport]);
  React.useLayoutEffect(()=>{
    const el=viewport.current,body=content.current;
    if(!el||!body||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>{if(pinned.current)el.scrollTop=el.scrollHeight;});
    observer.observe(body);
    return ()=>observer.disconnect();
  },[viewport,content]);
  return onScroll;
}
