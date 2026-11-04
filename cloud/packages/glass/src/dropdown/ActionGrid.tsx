import styles from './dropdown.module.css';
import React from 'react';
import {
  ACTION_GRID_MARKER,
  PanelHighlightContext,
  useGlassDropdownContext,
} from './context';
export interface ActionGridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: number;
  children: React.ReactNode;
}

function ActionGrid({
  columns = 3,
  children,
  className = '',
  style,
  ...rest
}: ActionGridProps) {
  return (
    <div
      role="group"
      data-slot="dropdown-action-grid"
      className={`${styles.actionGrid} ${className}`.trim()}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, ...style }}
      {...rest}
    >
      {children}
      <span aria-hidden className={styles.actionRule} />
    </div>
  );
}
(ActionGrid as unknown as { [ACTION_GRID_MARKER]: boolean })[
  ACTION_GRID_MARKER
] = true;

export interface TileItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect'
> {
  icon: React.ReactNode;
  active?: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}

const TileItem = React.forwardRef<HTMLButtonElement, TileItemProps>(
  function TileItem(
    {
      icon,
      active = false,
      keepOpen = false,
      disabled = false,
      onSelect,
      onClick,
      children,
      style,
      ...rest
    },
    ref,
  ) {
    const ctx = useGlassDropdownContext('TileItem');
    const panelHighlight = React.useContext(PanelHighlightContext);
    const itemId = React.useId();
    const isHighlighted = panelHighlight?.highlightedId === itemId;

    const activate = () => {
      if (disabled) return;
      onSelect?.();
      if (ctx.closeOnSelect && !keepOpen) {
        ctx.setOpen(false);
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        data-dropdown-item-id={itemId}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        data-highlighted={isHighlighted || undefined}
        onPointerEnter={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onFocus={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) activate();
        }}
        data-active={active || undefined}
        className={styles.tile}
        style={style}
        {...rest}
      >
        <span aria-hidden="true" className={styles.tileIcon}>
          {icon}
        </span>
        <span className={styles.truncate}>{children}</span>
      </button>
    );
  },
);

export { ActionGrid, TileItem };
