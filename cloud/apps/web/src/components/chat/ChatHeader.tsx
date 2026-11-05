import { GlassSurface, PANEL, popIn, usePreset, usePress, type GlassSurfaceProps } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import type React from 'react';
import { displayTitle } from '../../lib/chatTitle';
import { Edit, History, PanelLeft, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { useIsNarrow } from '../shell/useIsNarrow';
import { useContentShift } from '../shell/useContentShift';
import styles from './ChatHeader.module.css';

/** The navbar: floating glass over the full-bleed messages, a title pill and small action clusters. */
export function ChatHeader() {
  const store = usePraxisStore();
  const narrow = useIsNarrow();
  const shift = useContentShift();
  const pressProps = usePress();
  const pop = usePreset(popIn);
  const model = store.models.find(
    (m) => m.id === store.selectedModelId && m.providerId === store.selectedProviderId,
  );
  return (
    <header className={styles.bar} data-testid="chat-top-bar">
      <div className={styles.side}>
        <AnimatePresence initial={false}>
          {narrow ? (
            <Cluster key="history" {...pop}>
              {/* History is the floating sidebar panel on narrow screens. */}
              <BarButton label="History" testId="nav-history-button" onClick={() => store.setDesktopSidebarOpen(true)}>
                <History size={18} />
              </BarButton>
            </Cluster>
          ) : !store.desktopSidebarOpen ? (
            <Cluster key="sidebar" {...pop}>
              <BarButton label="Open sidebar" testId="nav-sidebar-button" onClick={() => store.setDesktopSidebarOpen(true)}>
                <PanelLeft size={18} />
              </BarButton>
            </Cluster>
          ) : null}
        </AnimatePresence>
      </div>

      <motion.div className={styles.center} initial={false} animate={{ x: shift }} transition={PANEL}>
        <GlassSurface material="regular" shape="capsule" className={styles.titlePill}>
          <motion.button
            type="button"
            className={styles.title}
            data-testid="nav-chat-title-pill"
            onClick={() => store.setActiveSheet('settings')}
            aria-label="Chat and model settings"
            {...pressProps}
          >
            <span className={styles.titleText}>{displayTitle(store.activeChat?.title || 'New chat')}</span>
            <span className={styles.model}>{model?.displayName || 'Select model'}</span>
          </motion.button>
        </GlassSurface>
      </motion.div>

      <div className={`${styles.side} ${styles.end}`}>
        {narrow ? (
          <Cluster>
            <BarButton label="New chat" testId="nav-new-chat-button" onClick={() => store.startNewConversation()}>
              <Edit size={18} />
            </BarButton>
          </Cluster>
        ) : (
          <Cluster>
            <BarButton label="New chat" testId="nav-new-chat-desktop" onClick={() => store.startNewConversation()}>
              <Edit size={18} />
            </BarButton>
            <BarButton label="Settings" testId="nav-settings-button" onClick={() => store.setActiveSheet('settings')}>
              <Settings size={18} />
            </BarButton>
          </Cluster>
        )}
      </div>
    </header>
  );
}

function Cluster({ children, ...motionProps }: { children: React.ReactNode } & GlassSurfaceProps) {
  return (
    <GlassSurface material="regular" shape="capsule" className={styles.cluster} {...motionProps}>
      {children}
    </GlassSurface>
  );
}

function BarButton({
  label,
  testId,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const pressProps = usePress();
  return (
    <motion.button
      type="button"
      className={styles.button}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      {...pressProps}
    >
      {children}
    </motion.button>
  );
}
