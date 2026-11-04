import { GlassSurface, usePress } from '@praxis/glass';
import { motion } from 'framer-motion';
import type React from 'react';
import { displayTitle } from '../../lib/chatTitle';
import { Edit, History, PanelLeft, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './ChatHeader.module.css';

/** Top bar: subtle centred title + model, and small glass clusters of actions. */
export function ChatHeader() {
  const store = usePraxisStore();
  const model = store.models.find(
    (m) => m.id === store.selectedModelId && m.providerId === store.selectedProviderId,
  );
  return (
    <header className={styles.bar} data-testid="chat-top-bar">
      <div className={styles.side}>
        <Cluster className={styles.narrow}>
          <BarButton label="History" testId="nav-history-button" onClick={() => store.setActiveSheet('history')}>
            <History size={18} />
          </BarButton>
        </Cluster>
        {!store.desktopSidebarOpen ? (
          <Cluster className={styles.desktop}>
            <BarButton label="Open sidebar" testId="nav-sidebar-button" onClick={() => store.setDesktopSidebarOpen(true)}>
              <PanelLeft size={18} />
            </BarButton>
          </Cluster>
        ) : null}
      </div>

      <button
        type="button"
        className={styles.title}
        data-testid="nav-chat-title-pill"
        onClick={() => store.setActiveSheet('settings')}
        aria-label="Chat and model settings"
      >
        <span className={styles.titleText}>{displayTitle(store.activeChat?.title || 'New chat')}</span>
        <span className={styles.model}>{model?.displayName || 'Select model'}</span>
      </button>

      <div className={`${styles.side} ${styles.end}`}>
        <Cluster className={styles.narrow}>
          <BarButton label="New chat" testId="nav-new-chat-button" onClick={() => store.startNewConversation()}>
            <Edit size={18} />
          </BarButton>
        </Cluster>
        <Cluster className={styles.desktop}>
          <BarButton label="New chat" testId="nav-new-chat-desktop" onClick={() => store.startNewConversation()}>
            <Edit size={18} />
          </BarButton>
          <BarButton label="Settings" testId="nav-settings-button" onClick={() => store.setActiveSheet('settings')}>
            <Settings size={18} />
          </BarButton>
        </Cluster>
      </div>
    </header>
  );
}

function Cluster({ className, children }: { className: string | undefined; children: React.ReactNode }) {
  return (
    <GlassSurface material="regular" shape="capsule" className={`${styles.cluster} ${className}`}>
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
