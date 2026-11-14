import React from 'react';
import { ChevronRight } from '../../../lib/icons';
import { holdScrollPosition } from '../../chat/Fold';
import styles from './Trace.module.css';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export type TraceStatus = 'running' | 'error' | 'pending';

interface TraceCollapsibleContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  contentId: string;
  triggerId: string;
}

const TraceCollapsibleContext = React.createContext<TraceCollapsibleContextValue | null>(null);
const TraceLineStatusContext = React.createContext<TraceStatus | undefined>(undefined);

export function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="trace" className={cx(styles.trace, className)} {...props} />;
}

export function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<'span'> & { status?: TraceStatus }) {
  return (
    <TraceLineStatusContext.Provider value={status}>
      <span
        data-slot="trace-line"
        data-status={status}
        className={cx(styles.line, className)}
        {...props}
      />
    </TraceLineStatusContext.Provider>
  );
}

export function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  const hasAccessibleName = Boolean(props['aria-label'] || props['aria-labelledby']);
  return (
    <span
      data-slot="trace-icon"
      aria-hidden={hasAccessibleName ? undefined : 'true'}
      className={cx(styles.icon, className)}
      {...props}
    />
  );
}

export function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  const status = React.useContext(TraceLineStatusContext);
  return (
    <span
      data-slot="trace-title"
      className={cx(
        styles.title,
        styles.label,
        status === 'running' && 'praxis-shimmer-text',
        className,
      )}
      {...props}
    />
  );
}

export function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cx(styles.description, className)}
      {...props}
    />
  );
}

export type TraceCollapsibleProps = React.ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function TraceCollapsible({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: TraceCollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const uid = React.useId();
  const contentId = `trace-content-${uid}`;
  const triggerId = `trace-trigger-${uid}`;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const value = React.useMemo(
    () => ({ open, setOpen, contentId, triggerId }),
    [open, setOpen, contentId, triggerId],
  );

  return (
    <TraceCollapsibleContext.Provider value={value}>
      <div
        data-slot="trace-collapsible"
        data-open={open ? 'true' : 'false'}
        className={cx(styles.collapsible, className)}
        {...props}
      />
    </TraceCollapsibleContext.Provider>
  );
}

export function TraceCollapsibleTrigger({
  className,
  children,
  onClick,
  id,
  ...props
}: React.ComponentProps<'button'>) {
  const ctx = React.useContext(TraceCollapsibleContext);
  const open = ctx?.open ?? false;

  return (
    <button
      type="button"
      id={id ?? ctx?.triggerId}
      data-slot="trace-collapsible-trigger"
      aria-expanded={open}
      aria-controls={ctx?.contentId}
      className={cx(styles.collapsibleTrigger, className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        holdScrollPosition(event.currentTarget);
        ctx?.setOpen(!open);
      }}
      {...props}
    >
      {children}
      <TraceIcon className={styles.chevron}>
        <ChevronRight size={16} />
      </TraceIcon>
    </button>
  );
}

export function TraceCollapsibleContent({
  className,
  children,
  keepMounted = true,
  rail = true,
  id,
  onTransitionEnd,
  ...props
}: React.ComponentProps<'div'> & {
  keepMounted?: boolean;
  rail?: boolean;
}) {
  const ctx = React.useContext(TraceCollapsibleContext);
  const open = ctx?.open ?? false;
  const ref = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(open || keepMounted);
  const [settled, setSettled] = React.useState(true);
  const prevOpenRef = React.useRef(open);

  if (open && !mounted) {
    setMounted(true);
  }
  if (keepMounted && !mounted) {
    setMounted(true);
  }
  if (prevOpenRef.current !== open) {
    prevOpenRef.current = open;
    if (settled) {
      setSettled(false);
    }
  }

  const finish = React.useCallback(() => {
    setSettled(true);
    if (!open && !keepMounted) {
      setMounted(false);
    }
  }, [open, keepMounted]);

  React.useEffect(() => {
    if (settled) return;
    const el = ref.current;
    const seconds = el
      ? Math.max(
          ...getComputedStyle(el)
            .transitionDuration.split(',')
            .map((v) => Number.parseFloat(v) || 0),
        )
      : 0;
    if (!(seconds > 0)) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, Math.ceil(seconds * 1000) + 60);
    return () => window.clearTimeout(timer);
  }, [settled, open, finish]);

  return (
    <div
      ref={ref}
      id={id ?? ctx?.contentId}
      data-slot="trace-collapsible-content"
      data-open={open ? 'true' : 'false'}
      data-settled={settled ? 'true' : 'false'}
      className={styles.collapsibleContent}
      onTransitionEnd={(event) => {
        onTransitionEnd?.(event);
        if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
          finish();
        }
      }}
      {...props}
    >
      <div className={styles.collapsibleContentInner} inert={!open}>
        {mounted ? (
          <div
            data-slot="trace-collapsible-body"
            className={cx(styles.contentBody, rail ? styles.rail : styles.noRail, className)}
          >
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
