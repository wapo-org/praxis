import { GlassDropdown } from '@praxis/glass';
import { MoreHorizontal, Pencil, Pin, Trash2 } from '../../lib/icons';
import styles from './Sidebar.module.css';

/** The row's "…" menu. A lazy chunk, with the dropdown engine, so the sidebar paints without it. */
export function ChatRowMenu({
  title,
  pinned,
  onTogglePin,
  onRename,
  onDelete,
}: {
  title: string;
  pinned?: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <GlassDropdown portal align="start">
      <GlassDropdown.Trigger asChild>
        <button type="button" className={styles.rowMenu} aria-label={`Actions for ${title}`}>
          <MoreHorizontal size={16} />
        </button>
      </GlassDropdown.Trigger>
      <GlassDropdown.Content minWidth={180}>
        <GlassDropdown.Item icon={<Pin size={16} />} onSelect={onTogglePin}>
          {pinned ? 'Unpin' : 'Pin'}
        </GlassDropdown.Item>
        <GlassDropdown.Item icon={<Pencil size={16} />} onSelect={onRename}>
          Rename
        </GlassDropdown.Item>
        <GlassDropdown.Separator variant="section" />
        <GlassDropdown.Item tone="destructive" icon={<Trash2 size={16} />} onSelect={onDelete}>
          Delete
        </GlassDropdown.Item>
      </GlassDropdown.Content>
    </GlassDropdown>
  );
}
