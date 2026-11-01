import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/** The only icon sizes (px) and the one stroke width; mirrored as --icon-* in tokens.css. */
export type IconSize = 16 | 18 | 20;
export const ICON_STROKE = 1.75;

export interface IconProps extends Omit<LucideProps, 'size' | 'strokeWidth' | 'absoluteStrokeWidth' | 'ref'> {
  icon: LucideIcon;
  size?: IconSize;
}

/** Wraps a lucide glyph and enforces the token size and stroke. */
export function Icon({ icon: Glyph, size = 18, ...rest }: IconProps) {
  return <Glyph size={size} strokeWidth={ICON_STROKE} aria-hidden={rest['aria-label'] ? undefined : true} {...rest} />;
}

export type BoundIcon = (props: Omit<IconProps, 'icon'>) => React.ReactElement;

/** Pre-binds a glyph so call sites read `<Plus size={16} />` but still go through <Icon>. */
export function bindIcon(glyph: LucideIcon): BoundIcon {
  const Bound: BoundIcon = (props) => <Icon icon={glyph} {...props} />;
  return Bound;
}
