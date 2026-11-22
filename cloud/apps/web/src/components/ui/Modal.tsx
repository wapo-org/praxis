import { GlassSurface, popIn, usePreset } from '@praxis/glass';
import React from 'react';
import { createPortal } from 'react-dom';
import { X } from '../../lib/icons';
import styles from './Modal.module.css';

export { styles as modalStyles };

export function Modal({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const pop = usePreset(popIn);
  const titleId = React.useId();
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal?.();
    // The first field, not the close button the dialog would pick.
    dialog.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')?.focus({ preventScroll: true });
    const onCancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      data-testid={testId}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.modalStage !== undefined) close.current();
      }}
    >
      <div className={styles.stage} data-modal-stage="">
        <GlassSurface
          material="thick"
          className={styles.panel}
          initial={{ opacity: 0, scale: pop.initial.scale }}
          animate={{ opacity: 1, scale: 1 }}
          transition={pop.transition}
        >
          <div className={styles.body}>
            <div className={styles.header}>
              <h2 id={titleId} className={styles.title}>
                {title}
              </h2>
              <button type="button" className={styles.close} aria-label="Close" onClick={() => close.current()}>
                <X size={16} />
              </button>
            </div>
            {children}
          </div>
        </GlassSurface>
      </div>
    </dialog>,
    document.body,
  );
}
