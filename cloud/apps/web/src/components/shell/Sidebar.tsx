import { GlassSurface, PANEL, sidebarSlide, usePreset, useReducedMotion } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { createPortal } from 'react-dom';
import { usePraxisStore } from '../../state/store';
import { isSettingsSheet } from '../screens/settingsNav';
import { SidebarChats } from './SidebarChats';
import { SidebarSettings } from './SidebarSettings';
import { useIsNarrow } from './useIsNarrow';
import styles from './Sidebar.module.css';

/**
 * The floating liquid-glass navigation (docked at ≥1024 px; on narrow screens the
 * same panel floats over the page). One surface for the whole app: chats normally,
 * the settings sections while Settings is open, so opening Settings changes this
 * panel's content rather than adding a second rail. It sits over the full-bleed
 * content layer and is always the window height minus its margins.
 */
export function Sidebar({ devTools = false }: { devTools?: boolean }) {
  const store = usePraxisStore();
  const narrow = useIsNarrow();
  const inSettings = isSettingsSheet(store.activeSheet);
  const atSettingsRoot = store.activeSheet === 'settings';
  // Entering Settings reveals its navigation; on narrow screens only at the root,
  // because a section link should land on its page.
  React.useEffect(() => {
    if (inSettings && (!narrow || atSettingsRoot)) store.setDesktopSidebarOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSettings, atSettingsRoot, narrow]);
  const close = () => store.setDesktopSidebarOpen(false);
  return (
    <AnimatePresence initial={false}>
      {!store.desktopSidebarOpen ? null : narrow ? (
        <SidebarPanel key="panel" onClose={close} devTools={devTools} />
      ) : (
        <Docked key="docked" onClose={close} devTools={devTools} />
      )}
    </AnimatePresence>
  );
}

function Docked({ onClose, devTools }: { onClose: () => void; devTools: boolean }) {
  const slide = usePreset(sidebarSlide);
  return (
    <motion.aside
      {...slide}
      className={styles.docked}
      aria-label="Conversation history"
      data-testid="app-sidebar"
    >
      <SidebarBody onClose={onClose} devTools={devTools} />
    </motion.aside>
  );
}

function SidebarBody({ onClose, onNavigate, devTools }: { onClose?: () => void; onNavigate?: () => void; devTools: boolean }) {
  const store = usePraxisStore();
  const reduced = useReducedMotion();
  const sheet = store.activeSheet;
  // Chats sit to the left of Settings: a push forward, a push back.
  const pane = (side: 1 | -1) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: PANEL }
      : {
          initial: { opacity: 0, x: 44 * side },
          animate: { opacity: 1, x: 0 },
          exit: { opacity: 0, x: 44 * side },
          transition: PANEL,
        };
  return (
    <GlassSurface material="thick" radius={20} className={styles.surface}>
      <AnimatePresence initial={false}>
        {isSettingsSheet(sheet) ? (
          <motion.div key="settings" className={styles.pane} {...pane(1)}>
            <SidebarSettings sheet={sheet} onNavigate={onNavigate} devTools={devTools} />
          </motion.div>
        ) : (
          <motion.div key="chats" className={styles.pane} {...pane(-1)}>
            <SidebarChats onClose={onClose} onNavigate={onNavigate} />
          </motion.div>
        )}
      </AnimatePresence>
    </GlassSurface>
  );
}

/**
 * Narrow screens: the panel floats over the page, the same model as desktop. No
 * scrim, no modal trap; Escape or an outside press closes it and focus returns to
 * the button that opened it.
 */
function SidebarPanel({ onClose, devTools }: { onClose: () => void; devTools: boolean }) {
  const asideRef = React.useRef<HTMLElement>(null);
  const close = React.useRef(onClose);
  close.current = onClose;
  const slide = usePreset(sidebarSlide);

  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    asideRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search conversations"]')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (asideRef.current?.contains(event.target as Node)) return;
      // Menus portal to the body: a press inside one is not an outside press.
      if ((event.target as Element).closest?.('.praxis-glass-dropdown-content')) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document
        .querySelector<HTMLElement>('[data-testid="nav-history-button"], [data-testid="nav-sidebar-button"]')
        ?.focus({ preventScroll: true });
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <motion.aside
      {...slide}
      ref={asideRef}
      className={styles.panel}
      aria-label="Conversation history"
      data-testid="app-sidebar"
      data-variant="panel"
    >
      <SidebarBody onClose={onClose} onNavigate={onClose} devTools={devTools} />
    </motion.aside>,
    document.body,
  );
}
