import styles from './dropdown.module.css';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { GlassSurface } from '../GlassSurface';
import { popIn, SPRING, TRANSITION } from '../motion';
import type { GlassMaterialControls } from '../GlassSurface';
import type { PanelHighlightContextValue } from './context';
import {
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
    const [highlightedId, setHighlightedId] = React.useState<string | null>(
      null,
    );
    const scopeId = React.useId();

    const highlightCtx = React.useMemo<PanelHighlightContextValue>(
      () => ({
        highlightedId,
        setHighlightedId,
        layoutScopeId: `sub-${scopeId}`,
      }),
      [highlightedId, scopeId],
    );

    if (!sub || ctx.submenuMode !== 'cascade') return null;

    return (
      <AnimatePresence>
        {sub.isOpen ? (
          <DepthContext.Provider value={sub.depth + 1}>
            <PanelHighlightContext.Provider value={highlightCtx}>
              <motion.div
                ref={forwardedRef}
                role="menu"
                aria-label={
                  typeof sub.label === 'string' ? sub.label : 'Submenu'
                }
                initial={{ scale: popIn.initial.scale, x: sub.openSide === 'right' ? -8 : 8 }}
                animate={{ scale: 1, x: 0 }}
                exit={{ scale: popIn.exit.scale, transition: TRANSITION.fast }}
                transition={SPRING}
                className={`${styles.subContent} ${sub.openSide === 'right' ? styles.subRight : styles.subLeft}`}
                style={style}
                onPointerLeave={() => setHighlightedId(null)}
                {...rest}
              >
                <GlassSurface
                  material={ctx.materialControls.material ?? 'thick'}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: TRANSITION.fast }}
                  transition={TRANSITION.base}
                  className={styles.surface}
                >
                  <div className={styles.list}>
                    {children}
                  </div>
                </GlassSurface>
              </motion.div>
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
