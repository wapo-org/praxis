import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { GlassSurface } from '../GlassSurface';
import type { GlassMaterialControls } from '../glass-store';
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
                initial={{
                  opacity: 0,
                  scale: 0.62,
                  x: sub.openSide === 'right' ? -10 : 10,
                }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.78,
                  transition: { duration: 0.12 },
                }}
                transition={{
                  type: 'spring',
                  stiffness: 460,
                  damping: 28,
                  mass: 0.8,
                }}
                style={{
                  position: 'absolute',
                  zIndex: 60,
                  minWidth: 224,
                  top: -6,
                  ...(sub.openSide === 'right'
                    ? { left: 'calc(100% + 8px)' }
                    : { right: 'calc(100% + 8px)' }),
                  ...style,
                }}
                onPointerLeave={() => setHighlightedId(null)}
                {...rest}
              >
                <GlassSurface
                  shape="free"
                  radius={22}
                  {...ctx.materialControls}
                  style={{ padding: 6 }}
                >
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                  >
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
