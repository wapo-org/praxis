import { usePress } from '@praxis/glass';
import type { Chat } from '@praxis/protocol';
import { m as motion } from 'framer-motion';
import React from 'react';
import { useAccount } from '../../lib/account';
import { groupChats } from '../../lib/chatGroups';
import { MoreHorizontal, PanelLeft, Pin, Search, Settings, Edit } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import styles from './Sidebar.module.css';

const loadRowMenu = () => import('./ChatRowMenu');
const ChatRowMenu = React.lazy(() => loadRowMenu().then((m) => ({ default: m.ChatRowMenu })));

/** Desktop sidebar (≥1024 px, 260 px, collapsible): new chat, search, chats by date, account. */
export function Sidebar() {
  const store = usePraxisStore();
  const account = useAccount();
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const groups = groupChats(store.chats, query, new Date());
  const pressProps = usePress();
  if (!store.desktopSidebarOpen) return null;

  return (
    <aside
      className={styles.sidebar}
      aria-label="Conversation history"
      data-testid="app-sidebar"
    >
      <div className={styles.header}>
        <span className={styles.brand}>Praxis</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close sidebar"
          data-testid="sidebar-toggle"
          onClick={() => store.setDesktopSidebarOpen(false)}
        >
          <PanelLeft size={18} />
        </button>
      </div>

      <nav className={styles.actions}>
        <motion.button
          type="button"
          className={styles.action}
          data-testid="sidebar-new-chat"
          onClick={() => store.startNewConversation()}
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
                <ChatRow key={chat.id} chat={chat} active={store.activeChatId === chat.id} />
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
          onClick={() => store.setActiveSheet('settings')}
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
    </aside>
  );
}

function ChatRow({ chat, active }: { chat: Chat; active: boolean }) {
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
          onFocus={(event) => event.target.select()}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(event) => event.key === 'Escape' && setRenaming(false)}
        />
      </form>
    );

  return (
    <div className={styles.row} data-testid="history-row" data-active={active}>
      <button
        type="button"
        className={styles.rowSelect}
        data-testid="history-row-select"
        aria-current={active ? 'page' : undefined}
        title={chat.title || 'New chat'}
        onClick={() => run(() => store.selectChat(chat.id))}
      >
        <span className={styles.rowTitle}>{chat.title || 'New chat'}</span>
        {chat.pinned ? <Pin size={16} aria-label="Pinned" className={styles.rowPin} /> : null}
      </button>
      <span className={styles.rowMenuWrap}>
        {/* Until the chunk arrives the same button shows, so the row never shifts. */}
        <React.Suspense
          fallback={
            <button type="button" className={styles.rowMenu} aria-label={`Actions for ${chat.title}`}>
              <MoreHorizontal size={16} />
            </button>
          }
        >
          <ChatRowMenu
            title={chat.title}
            pinned={chat.pinned}
            onTogglePin={() => run(() => store.togglePinChat(chat.id))}
            onRename={() => {
              setTitle(chat.title);
              setRenaming(true);
            }}
            onDelete={() => run(() => store.deleteChats([chat.id]))}
          />
        </React.Suspense>
      </span>
      {error ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
