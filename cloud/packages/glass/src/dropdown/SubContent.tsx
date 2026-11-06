import styles from './dropdown.module.css';
import { AnimatePresence } from 'framer-motion';
import React from 'react';
import { GlassMorph } from '../morph/GlassMorph';
import type { GlassMaterialControls } from '../GlassSurface';
import type { PanelHighlightContextValue } from './context';
import {
  DepthContext,
  PanelHighlightContext,
  SUB_CONTENT_MARKER,
  SubContext,
  useGlassDropdownContext,
} from './context';
/** --radius-lg, as the menu it came from. */
const SUBMENU_RADIUS = 16;

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
              <GlassMorph
                source={sub.getSubTriggerEl}
                radius={SUBMENU_RADIUS}
                material={ctx.materialControls.material ?? 'thick'}
                stretch="edge"
                className={styles.surface}
                shellRef={forwardedRef}
                shellProps={{
                  ...rest,
                  role: 'menu',
                  'aria-label': typeof sub.label === 'string' ? sub.label : 'Submenu',
                  className: `${styles.subContent} ${sub.openSide === 'right' ? styles.subRight : styles.subLeft}`,
                  style,
                  onPointerLeave: () => setHighlightedId(null),
                }}
              >
                  <div className={styles.list}>
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
