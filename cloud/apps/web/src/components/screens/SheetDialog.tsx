import { GlassSurface, MOTION } from '@praxis/glass';
import { motion, useReducedMotion } from 'framer-motion';
import React from 'react';
import { createPortal } from 'react-dom';

/** Each portal isolates the background, traps focus, and restores it on dismissal. */
export function SheetDialog({
  label,
  onDismiss,
  children,
  consent = false,
}: {
  label: string;
  onDismiss: () => void;
  children: React.ReactNode;
  consent?: boolean;
}) {
  const reduced = useReducedMotion();
  const [portal] = React.useState(() => document.createElement('div'));
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  React.useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    portal.className = 'praxis-sheets-portal';
    const siblings = Array.from(document.body.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    const states = siblings.map((node) => ({ node, inert: node.inert }));
    states.forEach(({ node }) => {
      node.inert = true;
    });
    document.body.append(portal);
    dialogRef.current?.focus();
    return () => {
      portal.remove();
      states.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
    };
  }, [portal]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (dialogRef.current?.querySelector('[role="menu"]')) return;
      event.stopPropagation();
      dismissRef.current();
    }
    if (event.key !== 'Tab') return;
    const elements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
      ) ?? [],
    ).filter((node) => node.getClientRects().length > 0 && !node.closest('[inert]'));
    const first = elements[0];
    const last = elements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      className={`screen-overlay${consent ? ' screen-overlay--consent' : ''}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismissRef.current();
      }}
    >
      <motion.div
        className="screen-dialog-position"
        initial={{ opacity: 0, y: reduced ? 0 : 36, scale: reduced ? 1 : 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0.15 } : MOTION.morph}
      >
        <GlassSurface className="screen-dialog" radius={24} shape="free" material="regular">
          <div
            className="screen-shell"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {children}
          </div>
        </GlassSurface>
      </motion.div>
    </div>,
    portal,
  );
}
