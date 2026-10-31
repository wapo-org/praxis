import React from 'react';
import { motion } from 'framer-motion';
import { GlassSurface, type GlassSurfaceProps } from './GlassSurface';
import { MOTION } from './tokens';

/**
 * GlassChip — Capsule glass chip for starter suggestions, filters, FileRef, LinkRef.
 */
export interface GlassChipProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
  > {
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}

export const GlassChip = React.forwardRef<HTMLButtonElement, GlassChipProps>(
  function GlassChip({ icon, trailing, active = false, children, className = '', style, ...rest }, ref) {
    return (
      <GlassSurface shape="capsule" material="thin" style={{display:"inline-flex"}}><motion.button
        ref={ref}
        type="button"
        whileTap={{ scale: 0.96, opacity: 0.84 }}
        transition={MOTION.press}
        className={`praxis-glass-chip ${className}`.trim()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          borderRadius: '9999px',
          border: '1px solid var(--paper-hairline)',
          background: active ? 'color-mix(in srgb, var(--paper-fill-2) 50%, transparent)' : 'transparent',
          color: 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          fontWeight: 500,
          lineHeight: '16px',
          cursor: 'pointer',
          userSelect: 'none',
          ...style,
        }}
        {...rest}
      >
        {icon ? <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--paper-secondary-ink)' }}>{icon}</span> : null}
        <span>{children}</span>
        {trailing ? <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--paper-muted-ink)' }}>{trailing}</span> : null}
      </motion.button></GlassSurface>
    );
  },
);

/**
 * GlassIconButton — 36x36 floating circular Liquid Glass button used in top nav & composer.
 */
export interface GlassIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}

export const GlassIconButton = React.forwardRef<HTMLButtonElement, GlassIconButtonProps>(
  function GlassIconButton({ size = 36, active = false, label, children, style, ...rest }, ref) {
    return (
      <GlassSurface
        shape="capsule"
        material="regular"
        bounce
        style={{ width: size, height: size, display: 'inline-flex' }}
      >
        <button
          ref={ref}
          type="button"
          aria-label={label}
          title={label}
          style={{
            width: size,
            height: size,
            borderRadius: '9999px',
            border: 'none',
            background: active ? 'var(--paper-fill-2)' : 'transparent',
            color: 'var(--paper-ink)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            ...style,
          }}
          {...rest}
        >
          {children}
        </button>
      </GlassSurface>
    );
  },
);

/**
 * GlassCard — Grouped card container matching Settings/Connectors 20px squircle cards.
 */
export function GlassCard({
  radius = 20,
  children,
  style,
  ...rest
}: GlassSurfaceProps) {
  return (
    <GlassSurface shape="free" radius={radius} material="thin" style={style} {...rest}>
      {children}
    </GlassSurface>
  );
}

/**
 * DotMeter — 5-dot capability meter (Speed ⚡ & Intelligence ✦) from PlusTray.swift.
 */
export function DotMeter({
  value = 3,
  max = 5,
  label,
}: {
  value?: number;
  max?: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span
      aria-label={label ? `${label}: ${clamped} of ${max}` : `${clamped} of ${max}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
      }}
    >
      {label ? (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--paper-secondary-ink)',
            marginInlineEnd: '3px',
          }}
        >
          {label}
        </span>
      ) : null}
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          style={{
            width: '5px',
            height: '5px',
            borderRadius: '9999px',
            backgroundColor: i < clamped ? 'var(--paper-ink)' : 'var(--paper-fill-2)',
            opacity: i < clamped ? 0.88 : 0.65,
          }}
        />
      ))}
    </span>
  );
}
