import type { Model } from '@praxis/protocol';
import React from 'react';
import { ModelListView } from '../chat/ModelList';
import styles from './Lab.module.css';

const FAMILIES = ['Atlas', 'Orbit', 'Lumen', 'Quill', 'Ember'];
const TAGLINES = ['Fast and thorough', 'Great for everyday work', 'Deep reasoning for hard problems', 'Long context'];

export const LAB_MODELS: Model[] = Array.from({ length: 500 }, (_, i) => ({
  type: 'model',
  id: `lab-model-${i + 1}`,
  providerId: 'lab',
  displayName: `${FAMILIES[i % FAMILIES.length]} ${i + 1}`,
  tagline: TAGLINES[i % TAGLINES.length],
  capabilities: {
    type: 'capabilities',
    tools: true,
    parallelToolCalls: i % 2 === 0,
    vision: i % 3 === 0,
    documents: false,
    imagesInToolResults: false,
    reasoningEffort: i % 2 === 0,
    streamUsage: true,
    explicitPromptCaching: false,
    serverWebSearch: i % 4 === 0,
    midConversationSystem: false,
    serverCompaction: false,
    toolSearch: false,
  },
  reasoningEfforts: ['low', 'medium', 'high'],
  pinned: i < 2,
  favorite: false,
})) as Model[];

/** The tray's real model list, fed 500 local models: same rows, search and windowing. */
export function LabModels() {
  const [query, setQuery] = React.useState('');
  const [models, setModels] = React.useState(LAB_MODELS);
  const [selectedId, setSelectedId] = React.useState(LAB_MODELS[0]!.id);
  const items = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? models.filter((m) => m.displayName.toLowerCase().includes(needle)) : models;
  }, [models, query]);
  return (
    <div className={styles.modelPanel} data-testid="lab-model-panel">
      <ModelListView
        query={query}
        onQueryChange={setQuery}
        search={{ items, cursor: null, busy: false, error: '', loadMore: () => {} }}
        providerName={() => 'Lab'}
        isSelected={(model) => model.id === selectedId}
        onSelect={(model) => setSelectedId(model.id)}
        onTogglePin={(model) =>
          setModels((previous) => previous.map((m) => (m.id === model.id ? { ...m, pinned: !m.pinned } : m)))
        }
        onBack={() => setQuery('')}
        autoFocus={false}
      />
    </div>
  );
}
