import { GlassDropdown } from '@praxis/glass';
import React from 'react';
import { Clock, FileText, Folder, Lock, Pin, Scan, Search } from '../../lib/icons';
import styles from './Lab.module.css';

const models = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Model ${String(i + 1).padStart(3, '0')}` }));
const recents = [
  'Plan the onboarding flow and list the open questions for next week',
  'Compare the three caching options and pick one for the release',
  'Draft the migration notes for the settings page and its new sections',
  'Summarise the accessibility review and what it means for the composer',
  'Sketch the keyboard shortcuts for search, new chat and the model list',
];

/** The real dropdown at nine anchors, with every row type. `?dropdown` is the positioning spec's fixture. */
export function DropdownPositions({ compact = false }: { compact?: boolean }) {
  const [action, setAction] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('Model 001');
  const [pinned, setPinned] = React.useState(new Set([0, 1, 4]));
  const filtered = React.useMemo(
    () => models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  return (
    <section aria-label="Dropdown positioning lab">
      <div className={styles.anchors} data-compact={compact}>
        {(['top', 'middle', 'bottom'] as const).map((row) => (
          <div key={row} className={styles.anchorRow}>
            {(['start', 'center', 'end'] as const).map((align) => (
              <GlassDropdown portal key={align} align={align}>
                <GlassDropdown.Trigger data-testid={`position-${row}-${align}`} hideChevron={compact}>
                  {row} {align}
                </GlassDropdown.Trigger>
                <GlassDropdown.Content minWidth={240} maxHeight={480}>
                  <GlassDropdown.ActionGrid>
                    <GlassDropdown.TileItem icon={<Scan size={16} />}>Scan</GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Pin size={16} />}>Pin chat</GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Lock size={16} />}>Lock</GlassDropdown.TileItem>
                  </GlassDropdown.ActionGrid>
                  <GlassDropdown.Item icon={<Search size={16} />}>Find in chat</GlassDropdown.Item>
                  <GlassDropdown.Item onSelect={() => setAction((n) => n + 1)} icon={<Folder size={16} />}>
                    Move chat
                  </GlassDropdown.Item>
                  <GlassDropdown.Sub id="recent" label="Recent chats" icon={<Clock size={16} />}>
                    <GlassDropdown.SubTrigger icon={<Clock size={16} />}>Recent chats</GlassDropdown.SubTrigger>
                    <GlassDropdown.SubContent>
                      {recents.map((text) => (
                        <GlassDropdown.Item key={text} icon={<FileText size={16} />} lines={3}>
                          {text}
                        </GlassDropdown.Item>
                      ))}
                    </GlassDropdown.SubContent>
                  </GlassDropdown.Sub>
                  <GlassDropdown.Item disabled>Unavailable</GlassDropdown.Item>
                  <GlassDropdown.Item subtitle="Suggest Results">Math Results</GlassDropdown.Item>
                  <GlassDropdown.Item>Lines &amp; Grids</GlassDropdown.Item>
                  <GlassDropdown.Item>Attachment View</GlassDropdown.Item>
                  <GlassDropdown.Item tone="destructive">Delete</GlassDropdown.Item>
                </GlassDropdown.Content>
              </GlassDropdown>
            ))}
          </div>
        ))}
      </div>
      {compact ? null : (
        <div className={styles.fixtureTools}>
          <output data-testid="dropdown-selections">{action}</output>
          <h2 className={styles.sectionTitle}>500 models in a dropdown, favorites marked once</h2>
          <GlassDropdown portal>
            <GlassDropdown.Trigger data-testid="position-models">{selected}</GlassDropdown.Trigger>
            <GlassDropdown.Content minWidth={340}>
              <GlassDropdown.Search value={query} onValueChange={setQuery} placeholder="Filter 500 models" />
              <GlassDropdown.VirtualList
                items={filtered}
                height={250}
                itemHeight={48}
                renderItem={(m) => (
                  <GlassDropdown.Item
                    disabled={m.id === 1}
                    selected={selected === m.name}
                    onSelect={() => setSelected(m.name)}
                    trailingAction={
                      <button
                        type="button"
                        aria-label={`Pin ${m.name}`}
                        aria-pressed={pinned.has(m.id)}
                        onClick={() =>
                          setPinned((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id);
                            else next.add(m.id);
                            return next;
                          })
                        }
                      >
                        {pinned.has(m.id) ? '★' : '☆'}
                      </button>
                    }
                  >
                    {m.name}
                  </GlassDropdown.Item>
                )}
              />
            </GlassDropdown.Content>
          </GlassDropdown>
        </div>
      )}
    </section>
  );
}
