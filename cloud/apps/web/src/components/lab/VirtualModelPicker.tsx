import { DotMeter, GlassDropdown, GlassSurface, useGlassRuntime } from '@praxis/glass';
import React from 'react';
import { Eye, Star, Zap } from '../../lib/icons';
import './lab.css';

import { SYNTHETIC_500_MODELS } from './syntheticModels';
export function VirtualModelPicker() {
  const material = useGlassRuntime((s) => s.overrides.material ?? 'regular');
  // 2. 500-Model Virtualized Picker state
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [modelSearch, setModelSearch] = React.useState('');
  const [selectedModelId, setSelectedModelId] = React.useState<string>('model-1');
  const [pinnedModelIds, setPinnedModelIds] = React.useState<Set<string>>(
    () => new Set(['model-1', 'model-2', 'model-5']),
  );

  const filteredModels = React.useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const list = q
      ? SYNTHETIC_500_MODELS.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q) ||
            m.tagline.toLowerCase().includes(q),
        )
      : SYNTHETIC_500_MODELS;
    return [...list].sort((a, b) => {
      const aPin = pinnedModelIds.has(a.id) ? 1 : 0;
      const bPin = pinnedModelIds.has(b.id) ? 1 : 0;
      return bPin - aPin;
    });
  }, [modelSearch, pinnedModelIds]);

  const selectedModel =
    SYNTHETIC_500_MODELS.find((m) => m.id === selectedModelId) ?? SYNTHETIC_500_MODELS[0]!;

  const togglePinModel = (id: string) => {
    setPinnedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section
      data-testid="virtual-model-picker-section"
      style={{
        borderRadius: '24px',
        border: '1px solid var(--paper-hairline)',
        backgroundColor: 'var(--paper-card)',
        padding: '22px',
        minHeight: '640px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--paper-muted-ink)',
              }}
            >
              60fps Windowed Combobox · 500 Synthetic Models
            </span>
            <h2 style={{ margin: '2px 0 0 0', fontSize: '16px', fontWeight: 600 }}>
              500-Model Virtualized Picker Demo
            </h2>
          </div>

          <GlassDropdown
            portal
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
            align="end"
            side="bottom"
          >
            <GlassDropdown.Trigger
              data-testid="virtual-model-picker-trigger"
              icon={<Zap size={14} />}
              value={selectedModel.contextWindow}
            >
              {selectedModel.name}
            </GlassDropdown.Trigger>

            <GlassDropdown.Content minWidth={340} maxHeight={380}>
              <GlassDropdown.Search
                data-testid="virtual-model-picker-search"
                value={modelSearch}
                onValueChange={setModelSearch}
                placeholder="Filter 500+ models…"
              />

              <GlassDropdown.VirtualList
                items={filteredModels}
                itemHeight={54}
                height={310}
                overscan={6}
                renderItem={(model) => {
                  const isPinned = pinnedModelIds.has(model.id);
                  return (
                    <GlassDropdown.Item
                      key={model.id}
                      selected={model.id === selectedModelId}
                      subtitle={model.tagline}
                      onSelect={() => setSelectedModelId(model.id)}
                      badge={
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          {model.vision ? (
                            <Eye
                              size={12}
                              aria-label="Vision supported"
                              style={{ color: 'var(--paper-secondary-ink)' }}
                            />
                          ) : null}
                          <DotMeter value={model.speed} label="⚡" />
                          <DotMeter value={model.intelligence} label="✦" />
                        </span>
                      }
                      trailingAction={
                        <button
                          type="button"
                          aria-label={isPinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
                          onClick={() => togglePinModel(model.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            padding: '4px',
                            cursor: 'pointer',
                            color: isPinned ? 'var(--paper-ink)' : 'var(--paper-muted-ink)',
                            display: 'inline-flex',
                          }}
                        >
                          <Star size={13} fill={isPinned ? 'currentColor' : 'none'} />
                        </button>
                      }
                    >
                      {model.name}
                    </GlassDropdown.Item>
                  );
                }}
              />
            </GlassDropdown.Content>
          </GlassDropdown>
        </div>

        {/* Active Model Summary Card + Inline Preview of Virtualization */}
        <GlassSurface
          shape="card"
          radius={18}
          material={material}
          style={{
            padding: '16px 18px',
            marginBottom: '16px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: 'var(--paper-secondary-ink)',
                }}
              >
                Active Selection · {selectedModel.provider}
              </div>
              <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '2px' }}>
                {selectedModel.name}
              </div>
              <div
                style={{
                  fontSize: '12.5px',
                  color: 'var(--paper-secondary-ink)',
                  marginTop: '2px',
                }}
              >
                {selectedModel.tagline}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <DotMeter value={selectedModel.speed} label="Speed ⚡" />
              <DotMeter value={selectedModel.intelligence} label="Intel ✦" />
            </div>
          </div>
        </GlassSurface>

        {/* Always-visible interactive virtualized list benchmark box */}
        <div
          style={{
            borderRadius: '16px',
            border: '1px solid var(--paper-hairline)',
            backgroundColor: 'var(--paper-canvas)',
            padding: '12px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px',
              fontSize: '12px',
              color: 'var(--paper-secondary-ink)',
            }}
          >
            <span>
              Showing {filteredModels.length} of {SYNTHETIC_500_MODELS.length} models (
              {pinnedModelIds.size} pinned ★)
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
              DOM window: ~18 nodes
            </span>
          </div>

          <GlassDropdown portal closeOnSelect={false}>
            <GlassDropdown.Trigger>Open benchmark picker</GlassDropdown.Trigger>
            <GlassDropdown.Content minWidth={320} maxHeight={260}>
              <GlassDropdown.Search
                value={modelSearch}
                onValueChange={setModelSearch}
                placeholder="Search 500 synthetic models by name or provider…"
              />
              <GlassDropdown.VirtualList
                items={filteredModels}
                itemHeight={52}
                height={210}
                overscan={5}
                renderItem={(model) => {
                  const isPinned = pinnedModelIds.has(model.id);
                  return (
                    <GlassDropdown.Item
                      key={model.id}
                      selected={model.id === selectedModelId}
                      subtitle={model.tagline}
                      keepOpen
                      onSelect={() => setSelectedModelId(model.id)}
                      badge={
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <DotMeter value={model.speed} label="⚡" />
                          <DotMeter value={model.intelligence} label="✦" />
                        </span>
                      }
                      trailingAction={
                        <button
                          type="button"
                          aria-label={isPinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
                          onClick={() => togglePinModel(model.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            padding: '4px',
                            cursor: 'pointer',
                            color: isPinned ? 'var(--paper-ink)' : 'var(--paper-muted-ink)',
                            display: 'inline-flex',
                          }}
                        >
                          <Star size={13} fill={isPinned ? 'currentColor' : 'none'} />
                        </button>
                      }
                    >
                      {model.name}
                    </GlassDropdown.Item>
                  );
                }}
              />
            </GlassDropdown.Content>
          </GlassDropdown>
        </div>
      </div>

      <div
        style={{
          marginTop: '16px',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--paper-secondary-ink)',
          paddingTop: '12px',
          borderTop: '1px solid var(--paper-hairline)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Selected: {selectedModel.id}</span>
        <span>
          Speed {selectedModel.speed}/5 · Intelligence {selectedModel.intelligence}/5
        </span>
      </div>
    </section>
  );
}
