import {TitleText} from '../chat/TitleText';
import { GlassDropdown, press, usePress } from '@praxis/glass';
import type { Chat } from '@praxis/protocol';
import { motion } from 'framer-motion';
import React from 'react';
import { useAccount } from '../../lib/account';
import { groupChats } from '../../lib/chatGroups';
import { normalizeTitle } from '../../lib/chatTitle';
import { MoreHorizontal, Pin, Search, Settings, Edit } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { chatActions } from '../../actions/registry';
import styles from './Sidebar.module.css';
import { SidebarHeader } from './SidebarHeader';

/** The floating panel's chats view: new chat, search, history, and the account row. */
export function SidebarChats({
  onClose,
  onNavigate,
}: {
  onClose?: () => void;
  onNavigate?: () => void;
}) {
  const store = usePraxisStore();
  const account = useAccount();
  const query = '';
  const groups = groupChats(store.chats, query, new Date());
  const pressProps = usePress();

  return (
    <>
      <SidebarHeader
        label="New chat"
        Icon={Edit}
        testId="sidebar-new-chat"
        onAction={() => {
          store.startNewConversation();
          onNavigate?.();
        }}
        onClose={() => {
          store.setDesktopSidebarOpen(false);
          onClose?.();
        }}
      />
      <nav className={styles.actions}>
        <motion.button
          type="button"
          className={styles.action}
          aria-label="Search conversations"
          onClick={() => {
            window.dispatchEvent(new Event('praxis:search'));
            onNavigate?.();
          }}
          {...pressProps}
        >
          <Search size={16} />
          <span className={styles.rowTitle}>Search</span>
        </motion.button>
      </nav>

      <div className={styles.list}>
        {groups.length === 0 ? (
          <p className={styles.empty}>
            {query ? 'No chats match your search.' : 'No conversations yet.'}
          </p>
        ) : (
          <>
            {groups.map(({ group, chats }) => (
              <section key={group} aria-label={group} className={styles.group}>
                <h2 className={styles.groupTitle}>{group}</h2>
                {chats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    active={store.activeChatId === chat.id}
                    onNavigate={onNavigate}
                  />
                ))}
              </section>
            ))}
          </>
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
          <Settings size={16} />
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
  const canPress = Object.keys(usePress()).length > 0;
  const [pressed, setPressed] = React.useState(false);
  const release = () => setPressed(false);
  const [renaming, setRenaming] = React.useState(false);
  const cleanTitle = normalizeTitle(chat.title) || 'New chat';
  const [title, setTitle] = React.useState(cleanTitle);
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
    <motion.div
      className={styles.row}
      data-active={active}
      data-pressed={pressed || undefined}
      data-sidebar-row=""
      initial={false}
      animate={{ scale: pressed && canPress ? press.whileTap.scale : 1 }}
      transition={press.transition}
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
        title={cleanTitle}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          setPressed(true);
          // The release can land anywhere (or the row re-renders under it): listen on the window, once.
          const up = () => {
            setPressed(false);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
          };
          window.addEventListener('pointerup', up, true);
          window.addEventListener('pointercancel', up, true);
        }}
        onPointerLeave={release}
        onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && !event.repeat && setPressed(true)}
        onKeyUp={release}
        onBlur={release}
        onClick={() => {
          run(() => store.selectChat(chat.id));
          onNavigate?.();
        }}
      >
        <span className={styles.rowTitle}><TitleText title={cleanTitle}/></span>
      </button>
      {chat.pinned ? (
        <span className={styles.rowPin}>
          <Pin size={16} aria-label="Pinned" />
        </span>
      ) : null}
      <span className={styles.rowMenuWrap}>
        <GlassDropdown portal align="start">
          <GlassDropdown.Trigger asChild>
            <button
              type="button"
              className={styles.rowMenu}
              aria-label={`Actions for ${normalizeTitle(chat.title)}`}
            >
              <MoreHorizontal size={16} />
            </button>
          </GlassDropdown.Trigger>
          <GlassDropdown.Content minWidth={180}>
            {chatActions(store, chat, () => {
              setTitle(cleanTitle);
              setRenaming(true);
            }).map((action) => (
              <React.Fragment key={action.id}>
                {action.id === 'delete' ? <GlassDropdown.Separator variant="section" /> : null}
                <GlassDropdown.Item
                  icon={<action.Icon size={16} />}
                  tone={action.id === 'delete' ? 'destructive' : undefined}
                  onSelect={() => run(async () => action.apply())}
                >
                  {action.label}
                </GlassDropdown.Item>
              </React.Fragment>
            ))}
          </GlassDropdown.Content>
        </GlassDropdown>
      </span>
      {error ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </motion.div>
  );
}
