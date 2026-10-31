import React from 'react';
import { GlassDropdown } from '@praxis/glass';
import { Scan, Pin, Lock, Search, Folder, Clock, FileText } from '../../lib/icons';

const models = Array.from({ length: 500 }, (_, i) => ({
  id: i,
  name: `Model ${String(i + 1).padStart(3, '0')}`,
}));
const previews = [
  'am i missing something? the protestors are over the line and still moving forward',
  'Using this repository, and plus find some for search and the next conversation',
  'figure of around 40% refers to ethnic kazakhs and the population around them',
  'Hi, I got disconnected again. My name is Artem, and I have a question about this',
  'Hi Fiero, okay so to summarise the total code and the changes we discussed',
];

export function DropdownPositions({ compact = false }: { compact?: boolean }) {
  const [action, setAction] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('Model 001');
  const [pinned, setPinned] = React.useState(new Set([0, 1, 4]));
  const filtered = React.useMemo(
    () =>
      models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  // Every model appears exactly once; favorites are marked in place.
  return (
    <section
      aria-label="Dropdown positioning lab"
      className={compact ? 'dropdown-positions-compact' : undefined}
      style={{ minHeight: compact ? undefined : '100dvh', color: 'var(--paper-ink)', minWidth: 0, padding: compact ? 16 : 0, border: compact ? '1px solid var(--paper-hairline)' : undefined, borderRadius: 20 }}
    >
      <div
        style={{
          height: compact ? 360 : '100dvh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background:
            'repeating-linear-gradient(25deg, #eee5d0 0 12px, #aaa 12px 13px, #faf9f6 13px 25px)',
        }}
      >
        {(['top', 'middle', 'bottom'] as const).map((row) => (
          <div
            key={row}
            style={{ display: compact ? 'grid' : 'flex', gridTemplateColumns: compact ? 'repeat(3, minmax(0, 1fr))' : undefined, gap: compact ? 4 : 0, justifyContent: 'space-between' }}
          >
            {(['start', 'center', 'end'] as const).map((align) => (
              <GlassDropdown portal key={align} align={align} style={{ minWidth: 0 }}>
                <GlassDropdown.Trigger data-testid={`position-${row}-${align}`} style={compact ? { fontSize: 11, padding: '6px 4px' } : undefined}>
                  {row} {align}
                </GlassDropdown.Trigger>
                <GlassDropdown.Content minWidth={240} maxHeight={480}>
                  <GlassDropdown.ActionGrid>
                    <GlassDropdown.TileItem icon={<Scan size={16} />}>
                      Scan
                    </GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Pin size={16} />}>
                      Pin Note
                    </GlassDropdown.TileItem>
                    <GlassDropdown.TileItem icon={<Lock size={16} />}>
                      Lock
                    </GlassDropdown.TileItem>
                  </GlassDropdown.ActionGrid>
                  <GlassDropdown.Item icon={<Search size={16} />}>
                    Find in Note
                  </GlassDropdown.Item>
                  <GlassDropdown.Item
                    onSelect={() => setAction((n) => n + 1)}
                    icon={<Folder size={16} />}
                  >
                    Move Note
                  </GlassDropdown.Item>
                  <GlassDropdown.Sub
                    id="recent"
                    label="Recent Notes"
                    icon={<Clock size={16} />}
                  >
                    <GlassDropdown.SubTrigger icon={<Clock size={16} />}>
                      Recent Notes
                    </GlassDropdown.SubTrigger>
                    <GlassDropdown.SubContent>
                      {previews.map((text) => (
                          <GlassDropdown.Item
                            key={text}
                            icon={<FileText size={16} />}
                            lines={3}
                          >
                            {text}
                          </GlassDropdown.Item>
                      ))}
                    </GlassDropdown.SubContent>
                  </GlassDropdown.Sub>
                  <GlassDropdown.Item disabled>Unavailable</GlassDropdown.Item>
                  <GlassDropdown.Item subtitle="Suggest Results">Math Results</GlassDropdown.Item>
                  <GlassDropdown.Item>Lines &amp; Grids</GlassDropdown.Item>
                  <GlassDropdown.Item>Attachment View</GlassDropdown.Item>
                  <GlassDropdown.Item tone="destructive">
                    Delete
                  </GlassDropdown.Item>
                </GlassDropdown.Content>
              </GlassDropdown>
            ))}
          </div>
        ))}
      </div>
      <div style={{ padding: 16 }}>
        <output data-testid="dropdown-selections">{action}</output>
        <h2>500-model picker · favorites marked once</h2>
        <GlassDropdown portal>
          <GlassDropdown.Trigger data-testid="position-models">
            {selected}
          </GlassDropdown.Trigger>
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
    </section>
  );
}
