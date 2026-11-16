import { motion } from 'framer-motion';
import { SPRING } from '../motion';
import { Check } from '../icons';
import React from 'react';
import { PanelHighlightContext, useGlassDropdownContext } from './context';
import styles from './dropdown.module.css';
export interface ItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect'
> {
  icon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  trailingAction?: React.ReactNode;
  subtitle?: React.ReactNode;
  shortcut?: string;
  badge?: React.ReactNode;
  tone?: 'default' | 'destructive';
  selected?: boolean;
  inset?: boolean;
  keepOpen?: boolean;
  lines?: 1 | 2 | 3;
  onSelect?: () => void;
}

const Item = React.forwardRef<HTMLButtonElement, ItemProps>(function Item(
  {
    icon,
    trailingIcon,
    trailingAction,
    subtitle,
    shortcut,
    badge,
    tone = 'default',
    selected,
    inset = false,
    keepOpen = false,
    lines = 1,
    disabled = false,
    onSelect,
    children,
    onClick,
    onPointerEnter,
    onPointerUp,
    className = '',
    style,
    ...otherProps
  },
  ref,
) {
  const ctx = useGlassDropdownContext('Item');
  const panelHighlight = React.useContext(PanelHighlightContext);
  const itemId = React.useId();
  const isHighlighted = panelHighlight?.highlightedId === itemId;
  const isDestructive = tone === 'destructive';

  const activate = () => {
    if (disabled) return;
    onSelect?.();
    if (ctx.closeOnSelect && !keepOpen) {
      ctx.setOpen(false);
    }
  };


  return (
    <div className={styles.itemWrap}>
      <button
        ref={ref}
        type="button"
        role={ctx.searchable ? 'option' : 'menuitem'}
        aria-selected={ctx.searchable ? !!selected : undefined}
        data-dropdown-item-id={itemId}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        data-highlighted={isHighlighted || undefined}
        data-tone={tone}
        data-trailing-action={trailingAction ? true : undefined}
        onPointerUp={onPointerUp}
        onPointerEnter={(e) => {
          onPointerEnter?.(e);
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onFocus={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented && !disabled) activate();
        }}
        className={`${styles.item} ${className}`.trim()}
        style={style}
        {...otherProps}
      >
        {isHighlighted && !disabled ? (
          <motion.span
            layoutId={`${panelHighlight?.layoutScopeId ?? 'menu'}-highlight`}
            aria-hidden="true"
            transition={SPRING}
            className={styles.highlight}
          />
        ) : null}

        {icon ? (
          <span aria-hidden="true" className={styles.slot}>
            {icon}
          </span>
        ) : selected !== undefined || inset ? (
          <span aria-hidden="true" className={`${styles.slot} ${styles.check}`}>
            {selected ? <Check size={16} /> : null}
          </span>
        ) : null}

        <span className={styles.copy}>
          <span
            className={lines === 1 ? styles.truncate : styles.clamp}
            style={lines === 1 ? undefined : { WebkitLineClamp: lines }}
          >
            {children}
          </span>
          {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
        </span>

        {icon && selected ? (
          <span aria-hidden="true" className={`${styles.trailingIcon} ${styles.check}`}>
            <Check size={16} />
          </span>
        ) : null}

        {badge !== undefined && badge !== null ? (
          <span className={`${styles.meta} ${styles.badge}`}>{badge}</span>
        ) : null}
        {shortcut ? <span className={styles.meta}>{shortcut}</span> : null}
        {trailingIcon ? (
          <span aria-hidden="true" className={styles.trailingIcon}>
            {trailingIcon}
          </span>
        ) : null}
      </button>
      {trailingAction ? (
        <span onClick={(e) => e.stopPropagation()} className={styles.trailingAction}>
          {trailingAction}
        </span>
      ) : null}
    </div>
  );
});

export { Item };
