import React from 'react';
const BOTTOM_EDGE=4;
const JUMP_THRESHOLD=160;
export function scrollMetrics(el:Pick<HTMLElement,'scrollHeight'|'clientHeight'|'scrollTop'>) {
  const overflow=Math.max(0,el.scrollHeight-el.clientHeight);
  const distance=Math.max(0,overflow-Math.max(0,el.scrollTop));
  return {overflow,distance,showJump:overflow>BOTTOM_EDGE&&distance>JUMP_THRESHOLD};
}
/** One source of truth for scroll following and its disclosure, including rendered (not transport) growth. */
export function useStreamAnchor(viewport:React.RefObject<HTMLElement|null>,content:React.RefObject<HTMLElement|null>,identity?:string,turnKey?:string,localSend=false) {
  const disclosure=React.useRef<{element:HTMLElement;top:number;until:number}|null>(null);
  const sentAnchor=React.useRef(false), userMoved=React.useRef(false);
  const previousTurn=React.useRef({identity,turnKey});
  const pinned=React.useRef(true),jumping=React.useRef(false),lastTop=React.useRef(0);
  const [state,setState]=React.useState({identity,show:false});
  const measure=React.useCallback((fromScroll=false)=>{
    const el=viewport.current;if(!el)return;
    const anchor=disclosure.current;
    if(anchor && anchor.element.isConnected && performance.now()<anchor.until){
      el.scrollTop+=anchor.element.getBoundingClientRect().top-anchor.top;
      lastTop.current=el.scrollTop;
      return;
    }
    let metrics=scrollMetrics(el);
    if(metrics.distance<=BOTTOM_EDGE||metrics.overflow<=BOTTOM_EDGE){
      if(!sentAnchor.current||userMoved.current)pinned.current=true;
      jumping.current=false;
    }
    else if(fromScroll&&!jumping.current&&Math.abs(el.scrollTop-lastTop.current)>1){
      userMoved.current=true;
      if(el.scrollTop<lastTop.current-1)pinned.current=false;
    }
    // Height growth can itself dispatch scroll (including browser anchoring).
    // It must not be mistaken for a user leaving the live edge.
    if(pinned.current&&metrics.distance>BOTTOM_EDGE&&!jumping.current){el.scrollTop=el.scrollHeight;metrics=scrollMetrics(el);}
    lastTop.current=el.scrollTop;
    const show=metrics.showJump&&!jumping.current&&(!sentAnchor.current||userMoved.current);
    setState(old=>old.identity===identity&&old.show===show?old:{identity,show});
  },[identity,viewport,content]);
  const onScroll=React.useCallback(()=>measure(true),[measure]);
  const jumpToLatest=React.useCallback((behavior:ScrollBehavior='smooth')=>{
    disclosure.current=null;
    const el=viewport.current;if(!el)return;
    pinned.current=true;jumping.current=true;
    setState({identity,show:false});
    el.scrollTo({top:el.scrollHeight,behavior});
    measure();
  },[identity,measure,viewport]);
  React.useLayoutEffect(()=>{
    disclosure.current=null;
    sentAnchor.current=false;userMoved.current=false;
    if(content.current)content.current.style.minHeight='';
    pinned.current=true;jumping.current=false;
    const el=viewport.current;if(el)el.scrollTop=el.scrollHeight;
    measure();
  },[identity,measure,viewport]);
  React.useLayoutEffect(() => {
    const previous = previousTurn.current;
    previousTurn.current = {identity, turnKey};
    if (!turnKey || previous.turnKey === turnKey || !localSend) return;
    const el = viewport.current, body = content.current;
    const bubbles = body?.querySelectorAll<HTMLElement>('[data-testid="user-message-bubble"]');
    const target = bubbles?.[bubbles.length - 1];
    if (!el || !body || !target) return;
    disclosure.current = null;
    pinned.current = false;
    jumping.current = true;
    sentAnchor.current = true;
    userMoved.current = false;
    const offset = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const padding = getComputedStyle(el);
    const paddingTop = parseFloat(padding.paddingTop);
    const paddingBottom = parseFloat(padding.paddingBottom);
    // Reserve the usable viewport, accounting for its existing header and composer padding once.
    body.style.minHeight = `${offset + Math.max(0, el.clientHeight - paddingTop - paddingBottom)}px`;
    const top = el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - paddingTop;
    jumping.current = Math.abs(el.scrollTop - top) > 1;
    setState({identity, show:false});
    el.scrollTo({top, behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }, [identity, turnKey, localSend, viewport, content]);
  React.useLayoutEffect(()=>{
    const el=viewport.current,body=content.current;if(!el||!body)return;
    const resized=()=>{
      if(pinned.current && !disclosure.current)el.scrollTop=el.scrollHeight;
      measure();
    };
    const landed=()=>{jumping.current=false;measure();};
    const interrupt=()=>{disclosure.current=null;userMoved.current=true;jumping.current=false;pinned.current=scrollMetrics(el).distance<=BOTTOM_EDGE;measure();};
    // A disclosure opened by the user: what it reveals grows below it, and the page must not follow it down.
    const hold=()=>{jumping.current=false;pinned.current=false;};
    let frame=0;
    const pinFrame=()=>{
      const anchor=disclosure.current;
      if(!anchor)return;
      measure();
      if(performance.now()<anchor.until)frame=requestAnimationFrame(pinFrame);
      else disclosure.current=null;
    };
    const pinDisclosure=(event:MouseEvent)=>{
      const control=(event.target as Element).closest<HTMLElement>('[aria-expanded]');
      if(!control || !body.contains(control))return;
      cancelAnimationFrame(frame);
      disclosure.current={element:control,top:control.getBoundingClientRect().top,until:performance.now()+800};
      jumping.current=false;pinned.current=false;userMoved.current=true;
      frame=requestAnimationFrame(pinFrame);
    };
    el.addEventListener('click',pinDisclosure,true);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resized):undefined;
    observer?.observe(el);observer?.observe(body);
    el.addEventListener('scrollend',landed);
    el.addEventListener('praxis:hold',hold);el.addEventListener('wheel',interrupt,{passive:true});el.addEventListener('touchstart',interrupt,{passive:true});el.addEventListener('keydown',interrupt);
    window.addEventListener('resize',resized);
    return ()=>{cancelAnimationFrame(frame);el.removeEventListener('click',pinDisclosure,true);observer?.disconnect();el.removeEventListener('scrollend',landed);el.removeEventListener('praxis:hold',hold);el.removeEventListener('wheel',interrupt);el.removeEventListener('touchstart',interrupt);el.removeEventListener('keydown',interrupt);window.removeEventListener('resize',resized);};
  },[content,measure,viewport]);
  return {onScroll,jumpToLatest,showJump:state.identity===identity&&state.show};
}
