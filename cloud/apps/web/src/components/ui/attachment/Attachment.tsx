import React from 'react';
import styles from './Attachment.module.css';

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

export type AttachmentState = 'idle' | 'uploading' | 'processing' | 'error' | 'done';
export type AttachmentSize = 'default' | 'sm' | 'xs';
export type AttachmentOrientation = 'horizontal' | 'vertical';

export interface AttachmentProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: AttachmentState;
  size?: AttachmentSize;
  orientation?: AttachmentOrientation;
}

export function Attachment({
  className,
  state = 'done',
  size = 'default',
  orientation = 'horizontal',
  ...props
}: AttachmentProps) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={cx(styles.attachment, className)}
      {...props}
    />
  );
}

export interface AttachmentMediaProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'icon' | 'image';
}

export function AttachmentMedia({ className, variant = 'icon', ...props }: AttachmentMediaProps) {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={cx(styles.media, className)}
      {...props}
    />
  );
}

export function AttachmentContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-content" className={cx(styles.content, className)} {...props} />;
}

export function AttachmentTitle({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="attachment-title" className={cx(styles.title, className)} {...props} />;
}

export function AttachmentDescription({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-slot="attachment-description" className={cx(styles.description, className)} {...props} />
  );
}

export function AttachmentActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-actions" className={cx(styles.actions, className)} {...props} />;
}

export interface AttachmentActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'ghost' | 'secondary';
  size?: 'icon-xs' | 'icon-sm';
}

export function AttachmentAction({
  className,
  variant = 'ghost',
  size = 'icon-xs',
  type = 'button',
  ...props
}: AttachmentActionProps) {
  return (
    <button
      type={type}
      data-slot="attachment-action"
      data-variant={variant}
      data-size={size}
      className={cx(styles.action, className)}
      {...props}
    />
  );
}

export interface AttachmentTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  render?: React.ReactElement<Record<string, unknown>>;
}

export function AttachmentTrigger({
  className,
  render,
  type,
  ...props
}: AttachmentTriggerProps) {
  if (render && React.isValidElement(render)) {
    const renderProps = render.props as Record<string, unknown>;
    return React.cloneElement(render, {
      ...props,
      ...renderProps,
      'data-slot': 'attachment-trigger',
      className: cx(styles.trigger, renderProps.className as string | undefined, className),
    });
  }
  return (
    <button
      type={type ?? 'button'}
      data-slot="attachment-trigger"
      className={cx(styles.trigger, className)}
      {...props}
    />
  );
}

export function AttachmentGroup({ className, onScroll, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  const syncFade = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 1) {
      el.style.setProperty('--fade-left', '0px');
      el.style.setProperty('--fade-right', '0px');
      return;
    }
    const left = Math.min(1, el.scrollLeft / 16) * 16;
    const right = Math.min(1, (maxScroll - el.scrollLeft) / 16) * 16;
    el.style.setProperty('--fade-left', `${Math.round(left)}px`);
    el.style.setProperty('--fade-right', `${Math.round(right)}px`);
  }, []);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    syncFade(el);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncFade(el)) : null;
    ro?.observe(el);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => syncFade(el)) : null;
    mo?.observe(el, { childList: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [syncFade]);

  return (
    <div
      ref={ref}
      data-slot="attachment-group"
      className={cx(styles.group, className)}
      onScroll={(event) => {
        syncFade(event.currentTarget);
        onScroll?.(event);
      }}
      {...props}
    />
  );
}
