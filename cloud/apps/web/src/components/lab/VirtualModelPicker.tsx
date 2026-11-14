import { GlassDropdown } from '@praxis/glass';
import React from 'react';
import { Star } from '../../lib/icons';
import { SYNTHETIC_500_MODELS } from './syntheticModels';
import styles from './GlassLabPage.module.css';
export function VirtualModelPicker() {
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('model-1');
  const [pins, setPins] = React.useState(new Set(['model-1', 'model-2', 'model-5']));
  const models = React.useMemo(
    () => SYNTHETIC_500_MODELS.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  return (
    <section data-testid="virtual-model-picker-section" className={styles.card}>
      <h2>500 models</h2>
      <GlassDropdown portal align="end">
        <GlassDropdown.Trigger data-testid="virtual-model-picker-trigger">
          {SYNTHETIC_500_MODELS.find((m) => m.id === selected)?.name}
        </GlassDropdown.Trigger>
        <GlassDropdown.Content>
          <GlassDropdown.Search
            data-testid="virtual-model-picker-search"
            placeholder="Filter 500 models…"
            value={query}
            onValueChange={setQuery}
          />
          <GlassDropdown.VirtualList
            items={models}
            itemHeight={40}
            height={280}
            renderItem={(model) => (
              <GlassDropdown.Item
                selected={selected === model.id}
                onSelect={() => setSelected(model.id)}
                trailingAction={
                  <button
                    type="button"
                    aria-label={`${pins.has(model.id) ? 'Unpin' : 'Pin'} ${model.name}`}
                    aria-pressed={pins.has(model.id)}
                    onClick={() =>
                      setPins((prev) => {
                        const next = new Set(prev);
                        if (next.has(model.id)) next.delete(model.id);
                        else next.add(model.id);
                        return next;
                      })
                    }
                  >
                    <Star size={16} fill={pins.has(model.id) ? 'currentColor' : 'none'} />
                  </button>
                }
              >
                {model.name}
              </GlassDropdown.Item>
            )}
          />
        </GlassDropdown.Content>
      </GlassDropdown>
    </section>
  );
}
