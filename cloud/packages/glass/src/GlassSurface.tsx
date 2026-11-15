import React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import styles from './glass.module.css';

export type GlassMaterial = 'regular' | 'thick' | 'clear';
export type GlassShape = 'capsule' | 'card';

export interface GlassMaterialControls {
  material?: GlassMaterial;
}

export interface GlassSurfaceProps extends HTMLMotionProps<'div'>, GlassMaterialControls {
  shape?: GlassShape;
  radius?: number;
}

export function glassClassName(material: GlassMaterial = 'regular', shape: GlassShape = 'card'): string {
  return [styles.glass, styles[material], shape === 'capsule' ? styles.capsule : '']
    .filter(Boolean)
    .join(' ');
}

/** Static CSS glass; pass motion props here so opacity fades backdrop blur together. */
export const GlassSurface = React.forwardRef<HTMLDivElement, GlassSurfaceProps>(function GlassSurface(
  { material = 'regular', shape = 'card', radius, className = '', style, children, ...rest },
  ref,
) {
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
});
