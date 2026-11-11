import {placeSubmenu} from './positioning';
import styles from './dropdown.module.css';
import { AnimatePresence } from 'framer-motion';
import React from 'react';
import { GlassMorph } from '../morph/GlassMorph';
import type { GlassMaterialControls } from '../GlassSurface';
import type { PanelHighlightContextValue } from './context';
import {
  assignForwardedRef,
  DepthContext,
  PanelHighlightContext,
  SUB_CONTENT_MARKER,
  SubContext,
  useGlassDropdownContext,
} from './context';
export interface SubContentProps
  extends
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
    >,
    GlassMaterialControls {
  children?: React.ReactNode;
}

const SubContent = React.forwardRef<HTMLDivElement, SubContentProps>(
  function SubContent({ children, style, ...rest }, forwardedRef) {
    const ctx = useGlassDropdownContext('SubContent');
    const sub = React.useContext(SubContext);
    const shell=React.useRef<HTMLDivElement|null>(null);
    const [placement,setPlacement]=React.useState<React.CSSProperties|null>(null);
    const setShell=React.useCallback((node:HTMLDivElement|null)=>{shell.current=node;assignForwardedRef(forwardedRef,node);},[forwardedRef]);
    React.useLayoutEffect(()=>{
      if(!sub?.isOpen||ctx.submenuMode!=='cascade')return;
      const el=shell.current,trigger=sub.getSubTriggerEl();
      if(!el||!trigger)return;
      const update=()=>{
        const placed=placeSubmenu(trigger.getBoundingClientRect(),el.offsetWidth,el.scrollHeight,window.innerWidth,window.innerHeight);
        const parent=el.offsetParent?.getBoundingClientRect();
        const surface=el.querySelector<HTMLElement>('[data-glass-surface]');
        const css=surface?getComputedStyle(surface):null;
        const padding=css?(parseFloat(css.paddingTop)||0)+(parseFloat(css.paddingBottom)||0):0;
        el.style.setProperty('--submenu-list-height',Math.max(0,placed.maxHeight-padding)+'px');
        setPlacement({left:placed.left-(parent?.left??0),right:'auto',top:placed.top-(parent?.top??0),width:placed.width,minWidth:0,maxWidth:'calc(100vw - 16px)',maxHeight:placed.maxHeight,visibility:'visible'});
      };
      update();
      const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);
      observer?.observe(el);observer?.observe(trigger);
      window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
      return()=>{observer?.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
    },[sub?.isOpen,sub?.getSubTriggerEl,ctx.submenuMode]);
    const [highlightedId, setHighlightedId] = React.useState<string | null>(
      null,
    );

    const highlightCtx = React.useMemo<PanelHighlightContextValue>(
      () => ({
        highlightedId,
        setHighlightedId,
      }),
      [highlightedId],
    );

    if (!sub || ctx.submenuMode !== 'cascade') return null;

    return (
      <AnimatePresence>
        {sub.isOpen ? (
          <DepthContext.Provider value={sub.depth + 1}>
            <PanelHighlightContext.Provider value={highlightCtx}>
              <GlassMorph
                source={sub.getSubTriggerEl}
                material={ctx.materialControls.material ?? 'thick'}
                stretch="edge"
                className={styles.surface}
                shellRef={setShell}
                ready={!!placement}
                shellProps={{
                  ...rest,
                  role: 'menu',
                  'aria-label': typeof sub.label === 'string' ? sub.label : 'Submenu',
                  className: `${styles.subContent} ${sub.openSide === 'right' ? styles.subRight : styles.subLeft}`,
                  style:{...style,...(placement??{visibility:'hidden'})},
                  onPointerLeave: () => setHighlightedId(null),
                }}
              >
                  <div className={styles.list} style={{maxHeight:'var(--submenu-list-height, calc(100vh - 32px))',overflowY:'auto',scrollbarWidth:'none'}}>
                    {children}
                  </div>
              </GlassMorph>
            </PanelHighlightContext.Provider>
          </DepthContext.Provider>
        ) : null}
      </AnimatePresence>
    );
  },
);
(SubContent as unknown as { [SUB_CONTENT_MARKER]: boolean })[
  SUB_CONTENT_MARKER
] = true;

export { SubContent };
