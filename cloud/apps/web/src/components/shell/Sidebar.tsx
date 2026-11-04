import { GlassDropdown, GlassSurface, usePress } from '@praxis/glass';
import type { Chat } from '@praxis/protocol';
import { motion } from 'framer-motion';
import React from 'react';
import { createPortal } from 'react-dom';
import { useAccount } from '../../lib/account';
import { groupChats } from '../../lib/chatGroups';
import { MoreHorizontal, PanelLeft, Pencil, Pin, Search, Settings, Edit, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './Sidebar.module.css';

function useIsNarrow() {
  const query = '(max-width: 1023px)';
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    const media = window.matchMedia(query);
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  return narrow;
}

/**
 * Floating liquid-glass sidebar (desktop ≥1024 px docked; narrow screens get
 * the same content as a floating panel). It floats over the full-bleed chat
 * layer, so scrolling messages pass behind its glass.
 */
export function Sidebar() {
  const store = usePraxisStore();
  const narrow = useIsNarrow();
  if (!store.desktopSidebarOpen) return null;
  if (narrow) return <SidebarPanel onClose={() => store.setDesktopSidebarOpen(false)} />;
  return (
    <aside className={styles.docked} aria-label="Conversation history" data-testid="app-sidebar">
      <SidebarBody onClose={() => store.setDesktopSidebarOpen(false)} />
    </aside>
  );
}

function SidebarBody({
  onClose,
  onNavigate,
}: {
  onClose?: () => void;
  /** Narrow panel only: close after navigating. */
  onNavigate?: () => void;
}) {
  const store = usePraxisStore();
  const account = useAccount();
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const groups = groupChats(store.chats, query, new Date());
  const pressProps = usePress();

  return (
    <GlassSurface material="thick" radius={20} className={styles.surface}>
      <div className={styles.header}>
        <span className={styles.brand}>Praxis</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close sidebar"
          data-testid="sidebar-toggle"
          onClick={() => {
            store.setDesktopSidebarOpen(false);
            onClose?.();
          }}
        >
          <PanelLeft size={18} />
        </button>
      </div>

      <nav className={styles.actions}>
        <motion.button
          type="button"
          className={styles.action}
          data-testid="sidebar-new-chat"
          onClick={() => {
            store.startNewConversation();
            onNavigate?.();
          }}
          {...pressProps}
        >
          <Edit size={18} />
          New chat
        </motion.button>
        <label className={styles.search}>
          <Search size={18} />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search conversations"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </nav>

      <div className={styles.list}>
        {groups.length === 0 ? (
          <p className={styles.empty}>{query ? 'No chats match your search.' : 'No conversations yet.'}</p>
        ) : (
          groups.map(({ group, chats }) => (
            <section key={group} aria-label={group} className={styles.group}>
              <h2 className={styles.groupTitle}>{group}</h2>
              {chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} active={store.activeChatId === chat.id} onNavigate={onNavigate} />
              ))}
            </section>
          ))
        )}
      </div>

      <footer className={styles.footer}>
        <motion.button
          type="button"
          className={styles.account}
          data-testid="sidebar-account"
          onClick={() => {
            store.setActiveSheet('settings');
            onNavigate?.();
          }}
          {...pressProps}
        >
          <span className={styles.avatar} aria-hidden="true">
            {(account?.userId ?? 'P').slice(0, 1).toUpperCase()}
          </span>
          <span className={styles.accountCopy}>
            <span className={styles.accountName}>{account?.userId ?? 'Praxis'}</span>
            <span className={styles.accountDetail}>Settings</span>
          </span>
          <Settings size={18} />
        </motion.button>
      </footer>
    </GlassSurface>
  );
}

/**
 * Narrow-screen history: the sidebar content as a floating glass panel
 * anchored top-left. No scrim, no modal trap; Escape or outside click closes
 * and focus returns to the History button.
 */
function SidebarPanel({ onClose }: { onClose: () => void }) {
  const asideRef = React.useRef<HTMLElement>(null);
  const close = React.useRef(onClose);
  close.current = onClose;

  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    asideRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search conversations"]')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (asideRef.current?.contains(event.target as Node)) return;
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
        .querySelector<HTMLElement>('[data-testid="nav-history-button"]')
        ?.focus({ preventScroll: true });
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <aside
      ref={asideRef}
      className={styles.panel}
      aria-label="Conversation history"
      data-testid="app-sidebar"
      data-variant="panel"
    >
      <SidebarBody onClose={onClose} onNavigate={onClose} />
    </aside>,
    document.body,
  );
}

function ChatRow({
  chat,
  active,
  onNavigate,
}: {
  chat: Chat;
  active: boolean;
  onNavigate?: () => void;
}) {
  const store = usePraxisStore();
  const [renaming, setRenaming] = React.useState(false);
  const [title, setTitle] = React.useState(chat.title);
  const [error, setError] = React.useState('');
  const run = (task: () => Promise<unknown>) =>
    void task().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Something went wrong'),
    );

  if (renaming)
    return (
      <form
        className={styles.rename}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          run(async () => {
            await store.renameChat(chat.id, title.trim());
            setRenaming(false);
          });
        }}
      >
        <input
          aria-label="Chat title"
          autoFocus
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(event) => event.key === 'Escape' && setRenaming(false)}
        />
      </form>
    );

  return (
    <div className={styles.row} data-active={active} data-sidebar-row="">
      <button
        type="button"
        className={styles.rowSelect}
        data-sidebar-row-select=""
        aria-current={active ? 'page' : undefined}
        title={chat.title || 'New chat'}
        onClick={() => {
          run(() => store.selectChat(chat.id));
          onNavigate?.();
        }}
      >
        <span className={styles.rowTitle}>{chat.title || 'New chat'}</span>
        {chat.pinned ? <Pin size={16} aria-label="Pinned" className={styles.rowPin} /> : null}
      </button>
      <span className={styles.rowMenuWrap}>
        <GlassDropdown portal align="start">
          <GlassDropdown.Trigger asChild>
            <button type="button" className={styles.rowMenu} aria-label={`Actions for ${chat.title}`}>
              <MoreHorizontal size={16} />
            </button>
          </GlassDropdown.Trigger>
          <GlassDropdown.Content minWidth={180}>
            <GlassDropdown.Item
              icon={<Pin size={16} />}
              onSelect={() => run(() => store.togglePinChat(chat.id))}
            >
              {chat.pinned ? 'Unpin' : 'Pin'}
            </GlassDropdown.Item>
            <GlassDropdown.Item
              icon={<Pencil size={16} />}
              onSelect={() => {
                setTitle(chat.title);
                setRenaming(true);
              }}
            >
              Rename
            </GlassDropdown.Item>
            <GlassDropdown.Separator variant="section" />
            <GlassDropdown.Item
              tone="destructive"
              icon={<Trash2 size={16} />}
              onSelect={() => run(() => store.deleteChats([chat.id]))}
            >
              Delete
            </GlassDropdown.Item>
          </GlassDropdown.Content>
        </GlassDropdown>
      </span>
      {error ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
