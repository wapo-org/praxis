import { GlassDropdown, GlassSurface, GlideHighlight, usePress } from '@praxis/glass';
import type { Chat } from '@praxis/protocol';
import { motion } from 'framer-motion';
import React from 'react';
import { useAccount } from '../../lib/account';
import { groupChats } from '../../lib/chatGroups';
import { MoreHorizontal, PanelLeft, Pencil, Pin, Search, Settings, Edit, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './Sidebar.module.css';

/** The floating panel's chats view: new chat, search, history, and the account row. */
export function SidebarChats({ onClose, onNavigate }: { onClose?: () => void; onNavigate?: () => void }) {
  const store = usePraxisStore();
  const account = useAccount();
  const [query, setQuery] = React.useState('');
  const groups = groupChats(store.chats, query, new Date());
  const pressProps = usePress();

  return (
    <>
      <div className={styles.header}>
        <span className={styles.brand}>Praxis</span>
        <motion.button
          type="button"
          className={styles.iconButton}
          aria-label="Close sidebar"
          data-testid="sidebar-toggle"
          onClick={() => {
            store.setDesktopSidebarOpen(false);
            onClose?.();
          }}
          {...pressProps}
        >
          <PanelLeft size={18} />
        </motion.button>
      </div>

      <nav className={styles.actions}>
        <GlideHighlight />
        <motion.button
          type="button"
          className={styles.action}
          data-glide=""
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
        <label className={styles.search} data-glide="">
          <Search size={18} />
          <input
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
          <>
            <GlideHighlight active='[data-sidebar-row][data-active="true"]' activeKey={`${store.activeChatId}|${groups.length}|${store.chats.length}`} className={styles.activePill} />
            <GlideHighlight />
            {groups.map(({ group, chats }) => (
              <section key={group} aria-label={group} className={styles.group}>
                <h2 className={styles.groupTitle}>{group}</h2>
                {chats.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} active={store.activeChatId === chat.id} onNavigate={onNavigate} />
                ))}
              </section>
            ))}
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <GlideHighlight />
        <motion.button
          type="button"
          className={styles.account}
          data-glide=""
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
    </>
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

  // Right-click opens the row actions, matching the old history sheet.
  const openRowMenu = (row: HTMLElement | null) =>
    row?.querySelector<HTMLButtonElement>(`[aria-label^="Actions for"]`)?.click();
  return (
    <div
      className={styles.row}
      data-active={active}
      data-sidebar-row=""
      data-glide=""
      onContextMenu={(event) => {
        event.preventDefault();
        openRowMenu(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.shiftKey && event.key === 'F10') {
          event.preventDefault();
          openRowMenu(event.currentTarget);
        }
      }}
    >
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
