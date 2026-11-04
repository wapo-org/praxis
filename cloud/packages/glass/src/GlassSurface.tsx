import React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { useElasticStretch } from './elastic';
import styles from './glass.module.css';

/** Three recipes: regular (composer, top-bar cluster), thick (menus, sheets), clear (small chips). */
export type GlassMaterial = 'regular' | 'thick' | 'clear';
export type GlassShape = 'capsule' | 'card';

export interface GlassMaterialControls {
  material?: GlassMaterial;
}

export interface GlassSurfaceProps extends HTMLMotionProps<'div'>, GlassMaterialControls {
  shape?: GlassShape;
  /** Corner radius in px for `card`; ignored for `capsule`. Prefer the token default. */
  radius?: number;
  /**
   * Liquid Glass stretch (default true): the surface stretches toward the
   * pointer while pressed and dragged, then springs back. The stretch runs on
   * a wrapper so the backdrop-filter element and its framer-motion transform
   * are never disturbed.
   */
  elastic?: boolean;
}

export function glassClassName(material: GlassMaterial = 'regular', shape: GlassShape = 'card'): string {
  return [styles.glass, styles[material], shape === 'capsule' ? styles.capsule : '']
    .filter(Boolean)
    .join(' ');
}

/**
 * A static CSS material. It never measures, never re-renders on scroll and runs no JS per frame.
 * Motion props (initial/animate/exit) go on this element so opacity fades the blur with it.
 */
export const GlassSurface = React.forwardRef<HTMLDivElement, GlassSurfaceProps>(function GlassSurface(
  { material = 'regular', shape = 'card', radius, elastic = true, className = '', style, children, ...rest },
  ref,
) {
  const elasticRef = useElasticStretch<HTMLDivElement>({ disabled: !elastic });
  if (!elastic) {
    return (
      <motion.div
        ref={ref}
        data-glass-surface=""
        data-glass-material={material}
        className={`${glassClassName(material, shape)} praxis-glass-surface ${className}`.trim()}
        style={
          radius === undefined || shape === 'capsule'
            ? style
            : ({ ...style, '--glass-radius': `${radius}px` } as HTMLMotionProps<'div'>['style'])
        }
        {...rest}
      >
        {children}
      </motion.div>
    );
  }
  // The elastic wrapper owns the stretch transform; it carries no backdrop,
  // so nested glass never sits inside another backdrop root.
  const display = typeof style?.display === 'string' ? style.display : undefined;
  const { display: _display, ...innerStyle } = (style ?? {}) as React.CSSProperties;
  return (
    <div
      ref={elasticRef}
      data-elastic-surface=""
      data-glass-material={material}
      className={styles.elastic}
      style={display ? { display } : undefined}
    >
      <motion.div
        ref={ref}
        data-glass-surface=""
        data-glass-material={material}
        className={`${glassClassName(material, shape)} praxis-glass-surface ${className}`.trim()}
        style={
          radius === undefined || shape === 'capsule'
            ? (innerStyle as HTMLMotionProps<'div'>['style'])
            : ({ ...innerStyle, '--glass-radius': `${radius}px` } as HTMLMotionProps<'div'>['style'])
        }
        {...rest}
      >
        {children}
      </motion.div>
    </div>
  );
});
