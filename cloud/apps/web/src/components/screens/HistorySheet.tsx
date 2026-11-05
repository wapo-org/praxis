import { GlassDropdown } from '@praxis/glass';
import type { Chat } from '@praxis/protocol';
import React from 'react';
import {
  Check,
  X,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
} from '../../lib/icons';
import { CHAT_GROUPS as GROUPS, dateGroup } from '../../lib/chatGroups';
import { usePraxisStore } from '../../state/store.js';
import {
  ScreenBody,
  ScreenButton,
  ScreenHeader,
  ScreenMenu,
  TaskError,
  useScreenTask,
} from './ScreenUI.js';
import styles from './History.module.css';

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour');
  return formatter.format(-Math.floor(seconds / 86400), 'day');
}

export function HistorySheet({ onSelect }: { onSelect?: () => void } = {}) {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'pinned'>('all');
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState('');
  const visible = store.chats
    .filter(
      (chat) =>
        (filter === 'all' || chat.pinned) &&
        chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selectedIds = store.chats.filter((chat) => selected.has(chat.id)).map((chat) => chat.id);
  const now = new Date();
  const hold = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPress = React.useRef(false);
  const pressStart = React.useRef({ x: 0, y: 0 });
  React.useEffect(() => () => clearTimeout(hold.current), []);
  const openActions = (row: HTMLElement) =>
    row.querySelector<HTMLButtonElement>('[data-history-row-action] button')?.click();

  return (
    <>
      <ScreenHeader
        title="Chats"
        onBack={onSelect}
        trailing={
          selecting ? (
            <ScreenButton
              onClick={() => {
                setSelecting(false);
                setSelected(new Set());
              }}
            >
              Done
            </ScreenButton>
          ) : (
            <ScreenMenu label="History options" icon={<MoreHorizontal size={18} />}>
              <GlassDropdown.Item onSelect={() => setFilter(filter === 'all' ? 'pinned' : 'all')}>
                {filter === 'all' ? 'Show pinned chats' : 'Show all chats'}
              </GlassDropdown.Item>
              <GlassDropdown.Item icon={<Check size={16} />} onSelect={() => setSelecting(true)}>
                Select chats
              </GlassDropdown.Item>
              <GlassDropdown.Item
                icon={<Settings size={16} />}
                onSelect={() => store.setActiveSheet('settings')}
              >
                Settings
              </GlassDropdown.Item>
            </ScreenMenu>
          )
        }
      />
      <ScreenBody>
        <TaskError error={task.error} />
        {visible.length === 0 ? (
          <p className={styles.empty}>
            {query
              ? 'No chats match your search.'
              : filter === 'pinned'
                ? 'No pinned chats yet.'
                : 'No conversations yet. Start a new chat below.'}
          </p>
        ) : null}
        <div className={styles.list}>
          {GROUPS.map((group) => {
            const rows = visible.filter((chat) => dateGroup(chat, now) === group);
            if (!rows.length) return null;
            return (
              <section className={styles.group} key={group} aria-label={group}>
                <h2 className={styles.groupTitle}>{group}</h2>
                {rows.map((chat) => {
                  return (
                    <div
                      key={chat.id}
                      className={styles.row}
                      data-testid="history-row"
                      data-row-actions
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openActions(event.currentTarget);
                      }}
                      onKeyDown={(event) => {
                        longPress.current = false;
                        if (event.shiftKey && event.key === 'F10') {
                          event.preventDefault();
                          openActions(event.currentTarget);
                        }
                      }}
                      onPointerDown={(event) => {
                        pressStart.current = {
                          x: event.clientX,
                          y: event.clientY,
                        };
                        longPress.current = false;
                        if (event.pointerType === 'touch') {
                          const row = event.currentTarget;
                          hold.current = setTimeout(() => {
                            longPress.current = true;
                            openActions(row);
                          }, 500);
                        }
                      }}
                      onPointerUp={() => clearTimeout(hold.current)}
                      onPointerCancel={() => clearTimeout(hold.current)}
                      onPointerMove={(event) => {
                        if (
                          Math.hypot(
                            event.clientX - pressStart.current.x,
                            event.clientY - pressStart.current.y,
                          ) > 8
                        )
                          clearTimeout(hold.current);
                      }}
                    >
                      {selecting ? (
                        <input
                          className={styles.check}
                          type="checkbox"
                          aria-label={`Select ${chat.title}`}
                          checked={selected.has(chat.id)}
                          onChange={(event) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (event.target.checked) next.add(chat.id);
                              else next.delete(chat.id);
                              return next;
                            })
                          }
                        />
                      ) : null}
                      {renaming === chat.id ? (
                        <form
                          className={styles.rename}
                          onSubmit={(event) => {
                            event.preventDefault();
                            void task.run(async () => {
                              await store.renameChat(chat.id, title.trim());
                              setRenaming(null);
                            });
                          }}
                        >
                          <input
                            className={styles.renameInput}
                            aria-label="Chat title"
                            autoFocus
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            onFocus={(event) => event.target.select()}
                            onKeyDown={(event) => {
                              // Escape leaves the rename, not the sheet.
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                setRenaming(null);
                              }
                            }}
                            maxLength={200}
                            required
                          />
                          <button
                            type="submit"
                            className={styles.renameAction}
                            aria-label="Save"
                            disabled={task.busy || !title.trim()}
                          >
                            <Check size={18} />
                          </button>
                          <button
                            type="button"
                            className={styles.renameAction}
                            aria-label="Cancel"
                            onClick={() => setRenaming(null)}
                          >
                            <X size={18} />
                          </button>
                        </form>
                      ) : (
                        <button
                          className={styles.select}
                          data-testid="history-row-select"
                          type="button"
                          aria-current={store.activeChatId === chat.id ? 'page' : undefined}
                          disabled={task.busy}
                          onClick={() => {
                            if (longPress.current) {
                              longPress.current = false;
                              return;
                            }
                            if (selecting) {
                              setSelected((previous) => {
                                const next = new Set(previous);
                                if (next.has(chat.id)) next.delete(chat.id);
                                else next.add(chat.id);
                                return next;
                              });
                            } else
                              void task.run(async () => {
                                await store.selectChat(chat.id);
                                onSelect?.();
                              });
                          }}
                        >
                          <span className={styles.leading}>
                            <MessageCircle size={18} aria-hidden="true" />
                          </span>
                          <span className={styles.copy}>
                            <span className={styles.title}>
                              <span className={styles.titleText}>{chat.title || 'New chat'}</span>
                              {chat.pinned ? (
                                <span className={styles.pin}>
                                  <Pin size={16} aria-label="Pinned" />
                                </span>
                              ) : null}
                            </span>
                            <time className={styles.time} dateTime={chat.updatedAt}>
                              {relativeTime(chat.updatedAt)}
                            </time>
                          </span>
                          {store.activeChatId === chat.id ? (
                            <span className={styles.current}>
                              <Check size={18} aria-label="Current chat" />
                            </span>
                          ) : null}
                        </button>
                      )}
                      {!selecting && renaming !== chat.id ? (
                        <div data-history-row-action className={styles.actions}>
                          <ScreenMenu
                            contextOnly
                            label={`Actions for ${chat.title}`}
                            icon={<MoreHorizontal size={16} />}
                          >
                            <GlassDropdown.Item
                              disabled={task.busy}
                              icon={<Pin size={16} />}
                              onSelect={() => {
                                void task.run(() => store.togglePinChat(chat.id));
                              }}
                            >
                              {chat.pinned ? 'Unpin' : 'Pin'}
                            </GlassDropdown.Item>
                            <GlassDropdown.Item
                              icon={<Pencil size={16} />}
                              onSelect={() => {
                                setTitle(chat.title);
                                setRenaming(chat.id);
                              }}
                            >
                              Rename
                            </GlassDropdown.Item>
                            <GlassDropdown.Separator variant="section" />
                            <GlassDropdown.Item
                              disabled={task.busy}
                              tone="destructive"
                              icon={<Trash2 size={16} />}
                              onSelect={() => {
                                void task.run(() => store.deleteChats([chat.id]));
                              }}
                            >
                              Delete
                            </GlassDropdown.Item>
                          </ScreenMenu>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </ScreenBody>
      <footer className={styles.footer}>
        {selecting ? (
          <ScreenButton
            tone="destructive"
            disabled={!selectedIds.length || task.busy}
            onClick={() => {
              void task.run(async () => {
                await store.deleteChats(selectedIds);
                setSelected(new Set());
                setSelecting(false);
              });
            }}
          >
            <Trash2 size={16} />
            Delete selected ({selectedIds.length})
          </ScreenButton>
        ) : (
          <ScreenButton
            tone="primary"
            disabled={task.busy}
            onClick={() => {
              void task.run(async () => {
                store.startNewConversation();
                onSelect?.();
              });
            }}
          >
            <Plus size={18} />
            New chat
          </ScreenButton>
        )}
        <label className={styles.search}>
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </footer>
    </>
  );
}
