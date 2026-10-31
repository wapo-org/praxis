import React from 'react';
import { ScrollBlur } from '../ProgressiveBlurScrim';
export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight?: number;
  height?: number;
  overscan?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  emptyState?: React.ReactNode;
}

function VirtualList<T>({
  items,
  itemHeight = 48,
  height = 300,
  overscan = 6,
  renderItem,
  emptyState,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = React.useState(0);
  const viewport = React.useRef<HTMLDivElement>(null);
  const host = React.useRef<HTMLDivElement>(null);
  const active = React.useRef(-1);
  const pending = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const el = host.current;
    const navigate = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const focused = document.activeElement?.closest<HTMLElement>(
        '[data-virtual-index]',
      );
      const current = focused
        ? Number(focused.dataset.virtualIndex)
        : active.current;
      let next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? items.length - 1
            : Math.max(
                0,
                Math.min(
                  items.length - 1,
                  current +
                    (key === 'ArrowUp'
                      ? -1
                      : key === 'PageUp'
                        ? -Math.floor(height / itemHeight)
                        : key === 'PageDown'
                          ? Math.floor(height / itemHeight)
                          : 1),
                ),
              );
      const step = ['End', 'ArrowUp', 'PageUp'].includes(key) ? -1 : 1;
      while (next >= 0 && next < items.length) {
        const candidate = renderItem(items[next]!, next);
        if (
          !React.isValidElement<{ disabled?: boolean }>(candidate) ||
          !candidate.props.disabled
        )
          break;
        next += step;
      }
      if (next < 0 || next >= items.length) return;
      // Retain the logical index across unmounted windows.
      active.current = next;
      pending.current = next;
      const top = Math.max(
        0,
        Math.min(next * itemHeight, items.length * itemHeight - height),
      );
      if (viewport.current) viewport.current.scrollTop = top;
      setScrollTop(top);
      const mounted = host.current?.querySelector<HTMLElement>(
        `[data-virtual-index="${next}"] [data-dropdown-item-id]:not([disabled])`,
      );
      if (mounted) {
        mounted.focus({ preventScroll: true });
        pending.current = null;
      }
    };
    el?.addEventListener('dropdown-navigate', navigate);
    return () => el?.removeEventListener('dropdown-navigate', navigate);
  }, [items, renderItem, height, itemHeight]);
  React.useLayoutEffect(() => {
    if (pending.current === null) return;
    host.current
      ?.querySelector<HTMLElement>(
        `[data-virtual-index="${pending.current}"] [data-dropdown-item-id]:not([disabled])`,
      )
      ?.focus({ preventScroll: true });
    pending.current = null;
  });
  React.useEffect(() => {
    active.current = -1;
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [items]);

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: '24px 12px',
          textAlign: 'center',
          fontSize: '13px',
          color: 'var(--paper-muted-ink)',
        }}
      >
        {emptyState ?? 'No matching items'}
      </div>
    );
  }

  const totalHeight = items.length * itemHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(height / itemHeight) + overscan * 2;
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const offsetY = startIndex * itemHeight;

  return (
    <div ref={host} data-dropdown-virtual>
      <ScrollBlur
        viewportRef={viewport}
        maxHeight={Math.min(height, totalHeight + 12)}
        scrimHeight={22}
        onViewportScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          style={{ position: 'relative', height: totalHeight, width: '100%' }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${offsetY}px)`,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {items.slice(startIndex, endIndex).map((item, i) => (
              <div
                data-virtual-index={startIndex + i}
                key={startIndex + i}
                style={{ minHeight: itemHeight }}
              >
                {renderItem(item, startIndex + i)}
              </div>
            ))}
          </div>
        </div>
      </ScrollBlur>
    </div>
  );
}

export { VirtualList };
