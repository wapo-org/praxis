import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { GlassSurface } from '../GlassSurface';
import { ScrollBlur } from '../ProgressiveBlurScrim';
import type { GlassMaterialControls } from '../glass-store';
import { MorphHeader } from './MorphHeader';
import { DropdownPortal } from './Portal';
import type { PanelHighlightContextValue, SubLevelInfo } from './context';
import {
  ACTION_GRID_MARKER,
  assignForwardedRef,
  DepthContext,
  PanelHighlightContext,
  SEARCH_MARKER,
  useGlassDropdownContext,
} from './context';
import { useKeyboard } from './keyboard';
import { resolveMorphTrail } from './morph';
import { useMenuReducedMotion } from './motion';
import { usePositioning } from './positioning';
import { usePressMotion } from './pressMotion';
export interface ContentProps
  extends
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
    >,
    GlassMaterialControls {
  maxHeight?: number;
  minWidth?: number;
  children?: React.ReactNode;
}

const Content = React.forwardRef<HTMLDivElement, ContentProps>(function Content(
  {
    maxHeight = 380,
    minWidth = 252,
    children,
    className = '',
    material,
    intensity,
    refraction,
    frost,
    finish,
    backdrop,
    stretchable = true,
    bounce,
    spotlight = true,
    onKeyDown,
    style,
    ...otherProps
  },
  forwardedRef,
) {
  const ctx = useGlassDropdownContext('Content');
  const pathKey = ctx.activeSubPath.join('/');
  const [highlightState, setHighlightState] = React.useState<{
    key: string;
    id: string | null;
  }>({
    key: pathKey,
    id: null,
  });
  const scopeId = React.useId();

  const highlightedId =
    highlightState.key === pathKey ? highlightState.id : null;
  const setHighlightedId = React.useCallback(
    (id: string | null) => setHighlightState({ key: pathKey, id }),
    [pathKey],
  );

  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      ctx.registerContentEl(node);
      assignForwardedRef(forwardedRef, node);
    },
    [ctx, forwardedRef],
  );

  const { position, resolvedSide } = usePositioning(ctx, minWidth);
  const handleKeyDown = useKeyboard(
    ctx,
    onKeyDown,
    position.visibility !== 'hidden',
  );
  const reduced = useMenuReducedMotion();
  const { pullX, pullY, stretchScaleY, pointerDownOriginRef } = usePressMotion(
    ctx,
    stretchable && !reduced,
    setHighlightedId,
  );

  const highlightCtx = React.useMemo<PanelHighlightContextValue>(
    () => ({
      highlightedId,
      setHighlightedId,
      layoutScopeId: `root-${scopeId}-${pathKey}`,
    }),
    [highlightedId, setHighlightedId, scopeId, pathKey],
  );

  const mergedControls: GlassMaterialControls = {
    material: material ?? ctx.materialControls.material ?? 'regular',
    intensity: intensity ?? ctx.materialControls.intensity,
    refraction: refraction ?? ctx.materialControls.refraction,
    frost: frost ?? ctx.materialControls.frost,
    finish: finish ?? ctx.materialControls.finish,
    backdrop: backdrop ?? ctx.materialControls.backdrop,
    stretchable: false,
    bounce,
    spotlight: spotlight ?? ctx.materialControls.spotlight ?? true,
  };

  const morphState = React.useMemo(() => {
    if (ctx.submenuMode !== 'morph' || ctx.activeSubPath.length === 0) {
      return { trail: [] as SubLevelInfo[], activeChildren: children };
    }
    return resolveMorphTrail(children, ctx.activeSubPath);
  }, [ctx.submenuMode, ctx.activeSubPath, children]);

  const activeMorphLevel =
    morphState.trail.length > 0
      ? morphState.trail[morphState.trail.length - 1]
      : null;

  // Separate top sticky ActionGrid / Search from scrollable list when at root level
  const topPinnedNodes: React.ReactNode[] = [];
  const scrollableNodes: React.ReactNode[] = [];

  React.Children.forEach(morphState.activeChildren, (child) => {
    if (
      !activeMorphLevel &&
      React.isValidElement(child) &&
      ((child.type as { [ACTION_GRID_MARKER]?: boolean })?.[
        ACTION_GRID_MARKER
      ] ||
        (child.type as { [SEARCH_MARKER]?: boolean })?.[SEARCH_MARKER])
    ) {
      topPinnedNodes.push(child);
    } else {
      scrollableNodes.push(child);
    }
  });

  return (
    <DropdownPortal enabled={ctx.portal}>
      <AnimatePresence>
        {ctx.open ? (
          <DepthContext.Provider value={0}>
            <PanelHighlightContext.Provider value={highlightCtx}>
              <motion.div
                ref={setRef}
                transformTemplate={reduced ? () => 'none' : undefined}
                id={ctx.menuId}
                role={ctx.searchable ? undefined : 'menu'}
                tabIndex={-1}
                aria-labelledby={ctx.triggerId}
                onKeyDown={handleKeyDown}
                onPointerDown={(e) => {
                  pointerDownOriginRef.current = { x: e.clientX, y: e.clientY };
                  ctx.startScrub();
                }}
                onPointerLeave={() => {
                  if (!pointerDownOriginRef.current) {
                    setHighlightedId(null);
                  }
                }}
                /* IMG_7745–IMG_7752 Unfurl Pop Motion */
                initial={
                  reduced
                    ? false
                    : {
                        opacity: 0,
                        scaleX: 0.38,
                        scaleY: 0.28,
                        y: resolvedSide === 'top' ? 10 : -10,
                        filter: 'blur(6px)',
                      }
                }
                animate={{
                  opacity: 1,
                  scaleX: 1,
                  scaleY: 1,
                  y: 0,
                  filter: 'blur(0px)',
                }}
                exit={
                  reduced
                    ? { opacity: 0, transition: { duration: 0.08 } }
                    : {
                        opacity: 0,
                        scaleX: 0.74,
                        scaleY: 0.74,
                        y: resolvedSide === 'top' ? 6 : -6,
                        filter: 'blur(4px)',
                        transition: { duration: 0.12, ease: 'easeIn' },
                      }
                }
                transition={
                  reduced
                    ? { duration: 0 }
                    : {
                        type: 'spring',
                        stiffness: 380,
                        damping: 24,
                        mass: 0.82,
                      }
                }
                className={`praxis-glass-dropdown-content ${className}`.trim()}
                style={{
                  position: ctx.portal ? 'fixed' : 'absolute',
                  zIndex: 80,
                  minWidth: Math.min(
                    minWidth,
                    typeof window === 'undefined'
                      ? minWidth
                      : window.innerWidth - 16,
                  ),
                  maxWidth: 'calc(100vw - 16px)',
                  overflowY: 'auto',
                  touchAction: 'none',
                  x: reduced ? 0 : pullX,
                  y: reduced ? 0 : pullY,
                  scaleY: reduced ? 1 : stretchScaleY,
                  ...style,
                  ...position,
                }}
                {...otherProps}
              >
                <GlassSurface
                  shape="free"
                  radius={24}
                  {...mergedControls}
                  style={{
                    width: '100%',
                    overflow:
                      ctx.submenuMode === 'cascade' ? 'visible' : 'hidden',
                    padding: '6px',
                    background: 'rgba(250,249,246,0.96)',
                    color: '#20201e',
                    ...({
                      '--paper-ink': '#20201e',
                      '--paper-secondary-ink': '#555550',
                      '--paper-muted-ink': '#555550',
                      '--paper-destructive': '#b42318',
                    } as React.CSSProperties),
                  }}
                >
                  {/* Layout-spring height container (IMG_7769–IMG_7774 submenu morph) */}
                  <motion.div
                    layout={reduced ? false : 'size'}
                    transition={{
                      type: 'spring',
                      stiffness: 360,
                      damping: 26,
                      mass: 0.85,
                    }}
                    style={{ width: '100%' }}
                  >
                    <AnimatePresence
                      mode="popLayout"
                      initial={false}
                      custom={ctx.morphDirection}
                    >
                      <motion.div
                        key={pathKey || '__root__'}
                        data-dropdown-panel={pathKey || '__root__'}
                        custom={ctx.morphDirection}
                        initial={
                          reduced
                            ? false
                            : {
                                opacity: 0,
                                y: ctx.morphDirection > 0 ? 12 : -12,
                                scale: 0.97,
                              }
                        }
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                        }}
                        exit={
                          reduced
                            ? { opacity: 0 }
                            : {
                                opacity: 0,
                                y: ctx.morphDirection > 0 ? -12 : 12,
                                scale: 0.97,
                                transition: { duration: 0.12 },
                              }
                        }
                        transition={
                          reduced
                            ? { duration: 0 }
                            : {
                                type: 'spring',
                                stiffness: 420,
                                damping: 30,
                                mass: 0.8,
                              }
                        }
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          width: '100%',
                        }}
                      >
                        {/* Elevated Submenu Sticky Header (IMG_7773–IMG_7774: "Recent Notes ⌄") */}
                        <MorphHeader level={activeMorphLevel ?? null} />

                        {/* Top pinned ActionGrid & Search */}
                        {topPinnedNodes}

                        {/* Scrollable items with progressive blur edge scrims */}
                        <ScrollBlur maxHeight={maxHeight} scrimHeight={20}>
                          <DepthContext.Provider
                            value={morphState.trail.length}
                          >
                            <div
                              id={
                                ctx.searchable
                                  ? `${ctx.menuId}-listbox`
                                  : undefined
                              }
                              role={ctx.searchable ? 'listbox' : undefined}
                              aria-labelledby={
                                ctx.searchable ? ctx.triggerId : undefined
                              }
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '2px',
                                width: '100%',
                              }}
                            >
                              {scrollableNodes}
                            </div>
                          </DepthContext.Provider>
                        </ScrollBlur>
                      </motion.div>
                    </AnimatePresence>
                  </motion.div>
                </GlassSurface>
              </motion.div>
            </PanelHighlightContext.Provider>
          </DepthContext.Provider>
        ) : null}
      </AnimatePresence>
    </DropdownPortal>
  );
});

export { Content };
