import React from 'react';
import { m as motion, type HTMLMotionProps } from 'framer-motion';
import { GlassSurface, type GlassSurfaceProps } from './GlassSurface';
import { usePress } from './motion';
import styles from './primitives.module.css';

/** GlassChip — clear-glass capsule for suggestions and small filters (36 px). */
export interface GlassChipProps extends HTMLMotionProps<'button'> {
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}

export const GlassChip = React.forwardRef<HTMLButtonElement, GlassChipProps>(function GlassChip(
  { icon, trailing, active = false, children, className = '', ...rest },
  ref,
) {
  const pressProps = usePress();
  return (
    <GlassSurface material="clear" shape="capsule" style={{ display: 'inline-flex' }}>
      <motion.button
        ref={ref}
        type="button"
        data-active={active}
        className={`praxis-glass-chip ${styles.chip} ${className}`.trim()}
        {...pressProps}
        {...rest}
      >
        {icon ? <span className={styles.chipIcon}>{icon}</span> : null}
        <span>{children}</span>
        {trailing ? <span className={styles.chipIcon}>{trailing}</span> : null}
      </motion.button>
    </GlassSurface>
  );
});

/** GlassIconButton — 36 px circular glass control for floating chrome. */
export interface GlassIconButtonProps extends HTMLMotionProps<'button'> {
  active?: boolean;
  label: string;
  children: React.ReactNode;
}

export const GlassIconButton = React.forwardRef<HTMLButtonElement, GlassIconButtonProps>(
  function GlassIconButton({ active = false, label, children, className = '', ...rest }, ref) {
    const pressProps = usePress();
    return (
      <GlassSurface material="regular" shape="capsule" style={{ display: 'inline-flex' }}>
        <motion.button
          ref={ref}
          type="button"
          aria-label={label}
          title={label}
          data-active={active}
          className={`${styles.iconButton} ${className}`.trim()}
          {...pressProps}
          {...rest}
        >
          {children}
        </motion.button>
      </GlassSurface>
    );
  },
);

/** GlassCard — a thick-glass card for floating panels. Not for content. */
export function GlassCard({ radius = 20, children, ...rest }: GlassSurfaceProps) {
  return (
    <GlassSurface material="thick" radius={radius} {...rest}>
      {children}
    </GlassSurface>
  );
}

/** DotMeter — 5-dot capability meter (Speed / Intelligence) from PlusTray.swift. */
export function DotMeter({ value = 3, max = 5, label }: { value?: number; max?: number; label?: string }) {
  const clamped = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span className={styles.meter} aria-label={label ? `${label}: ${clamped} of ${max}` : `${clamped} of ${max}`}>
      {label ? <span className={styles.meterLabel}>{label}</span> : null}
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={styles.dot} data-on={i < clamped} />
      ))}
    </span>
  );
}
