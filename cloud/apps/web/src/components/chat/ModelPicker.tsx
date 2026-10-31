import React from 'react';
import { GlassDropdown, DotMeter } from '@praxis/glass';
import { ChevronRight, Star } from '../../lib/icons';
import { useModelSearch } from '../../lib/useModelSearch';
import { usePraxisStore } from '../../state/store';
import type { Model } from '@praxis/protocol';

export function getUnpinnedModels<T extends { pinned?: boolean; favorite?: boolean }>(models: T[]) {
  return models.filter(m => !m.pinned && !m.favorite);
}
export function ModelPicker() {
  const store = usePraxisStore();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const result = useModelSearch(query, open);
  const model = store.models.find(m => m.providerId === store.selectedProviderId && m.id === store.selectedModelId);
  const pinned = result.items.filter(m => m.pinned || m.favorite);
  const others = getUnpinnedModels(result.items);
  const row = (m: Model) => <GlassDropdown.Item key={`${m.providerId}-${m.id}`} lines={2}
    subtitle={m.tagline || m.providerId} selected={m.id === store.selectedModelId && m.providerId === store.selectedProviderId}
    onSelect={() => { store.cacheModels([m]); store.setSelectedModel(m.providerId, m.id); }}
    trailingAction={<span role="button" tabIndex={0} aria-label={`${m.pinned ? 'Unpin' : 'Pin'} ${m.displayName}`} onClick={e => {
      e.stopPropagation(); void store.toggleModelPin(m.providerId, m.id, !m.pinned).then(result.refresh);
    }}><Star size={16} fill={m.pinned ? 'currentColor' : 'none'} /></span>}>
    <span>{m.displayName}</span>{typeof m.intelligence === 'number' && <DotMeter value={m.intelligence} label="Intelligence" />}
  </GlassDropdown.Item>;
  return <GlassDropdown open={open} onOpenChange={setOpen} align="center" side="top" style={{ width: '100%' }}>
    <GlassDropdown.Trigger asChild hideChevron><button type="button" data-testid="tray-model-picker-trigger" className="tray-model-row">
      <span><strong>{model?.displayName || 'Select model'}</strong><small>{model?.tagline || 'Choose a model for this chat'}</small></span><ChevronRight size={18} />
    </button></GlassDropdown.Trigger>
    <GlassDropdown.Content minWidth={320} maxHeight={420}>
      <GlassDropdown.Search value={query} onValueChange={setQuery} placeholder="Search models…" />
      {result.error && <p role="alert">{result.error}</p>}
      {pinned.length > 0 && <><GlassDropdown.Label>Pinned</GlassDropdown.Label>{pinned.map(row)}<GlassDropdown.Separator /></>}
      <GlassDropdown.Label>All Models ({others.length}{result.cursor ? '+' : ''})</GlassDropdown.Label>
      {others.length > 35 ? <GlassDropdown.VirtualList items={others} itemHeight={58} height={240} renderItem={row} /> : others.map(row)}
      {result.busy && <p role="status">Searching…</p>}
      {!result.busy && !result.items.length && !result.error && <p>No models found.</p>}
      {result.cursor && <GlassDropdown.Item keepOpen disabled={result.busy} onSelect={() => { result.loadMore(); }}>Load more models</GlassDropdown.Item>}
    </GlassDropdown.Content>
  </GlassDropdown>;
}
