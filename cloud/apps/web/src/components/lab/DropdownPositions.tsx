import React from 'react';
import styles from './DropdownPositions.module.css';
import { GlassDropdown } from '@praxis/glass';
import { Scan, Pin, Lock, Search, Folder, Clock, FileText } from '../../lib/icons';

const models = Array.from({ length: 500 }, (_, i) => ({
  id: i,
  name: `Model ${String(i + 1).padStart(3, '0')}`,
}));
const previews = [
  'Design review and next steps: compare the latest interface captures, record outstanding questions and prepare a focused plan for the next iteration.',
  'Release checklist and milestones: verify the desktop and narrow screen layouts, accessibility behavior and the remaining integration requirements.',
  'Research notes and open questions: gather the relevant references and summarize the findings alongside their sources for the project review.',
  'Weekly summary and team updates: review completed work, remaining dependencies and the decisions needed before the next milestone can begin.',
  'Planning the next conversation: collect the project context, recent changes and the most useful questions to make the next review productive.',
];

export function DropdownPositions({ compact = false }: { compact?: boolean }) {
  const [action, setAction] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('Model 001');
  const [pinned, setPinned] = React.useState(new Set([0, 1, 4]));
  const filtered = React.useMemo(
    () => models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  // Every model appears exactly once; favorites are marked in place.
  return (
    <section
      aria-label="Dropdown positioning lab"
      className={styles.section}
      data-compact={compact}
    >
      <div className={styles.stage}>
        {(['top', 'middle', 'bottom'] as const).map((row) => (
          <div key={row} className={styles.row}>
            {(['start', 'center', 'end'] as const).map((align) => (
              <GlassDropdown portal key={align} align={align} className={styles.dropdown}>
                <GlassDropdown.Trigger
                  data-testid={`position-${row}-${align}`}
                  className={styles.trigger}
                >
                  {row} {align}
                </GlassDropdown.Trigger>
                <GlassDropdown.Content minWidth={240} maxHeight={380}>
                  <GlassDropdown.ActionGrid>
                    <GlassDropdown.TileItem icon={<Scan size={16} />}>Scan</GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Pin size={16} />}>
                      Pin Note
                    </GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Lock size={16} />}>Lock</GlassDropdown.TileItem>
                  </GlassDropdown.ActionGrid>
                  <GlassDropdown.Item icon={<Search size={16} />}>Find in Note</GlassDropdown.Item>
                  <GlassDropdown.Item
                    onSelect={() => setAction((n) => n + 1)}
                    icon={<Folder size={16} />}
                  >
                    Move Note
                  </GlassDropdown.Item>
                  <GlassDropdown.Sub id="recent" label="Recent chats" icon={<Clock size={16} />}>
                    <GlassDropdown.SubTrigger icon={<Clock size={16} />}>
                      Recent chats
                    </GlassDropdown.SubTrigger>
                    <GlassDropdown.SubContent>
                      <GlassDropdown.Label>This week</GlassDropdown.Label>
                      <GlassDropdown.Label>Earlier</GlassDropdown.Label>
                      {previews.map((text) => (
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
      {!compact && (
        <div className={styles.footer}>
          <output data-testid="dropdown-selections">{action}</output>
          <h2>500-model picker · favorites marked once</h2>
          <GlassDropdown portal>
            <GlassDropdown.Trigger data-testid="position-models">{selected}</GlassDropdown.Trigger>
            <GlassDropdown.Content minWidth={340}>
              <GlassDropdown.Search
                value={query}
                onValueChange={setQuery}
                placeholder="Filter 500 models"
              />
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
