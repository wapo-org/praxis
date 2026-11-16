import type { ModelListItem } from '@praxis/protocol';
import React from 'react';
import { Check, Eye } from '../../lib/icons';

import { modelDetail } from '../../lib/models';
import { useModelSearch } from '../../lib/useModelSearch';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';
import styles from './Screen.module.css';

export function ImageReaderScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const vision = store.preferences?.vision;
  const enabled = vision?.enabled ?? true;
  // The catalogue says which models take images; nothing is probed or guessed.
  const search = useModelSearch(query, true, store.models);
  const models = search.items.filter((model) => model.capabilities.images);
  const choose = (model: ModelListItem) => {
    void task.run(() => store.updatePreferences({ vision: { enabled: true, modelId: model.id } }));
  };
  return (
    <ScreenBody>
      <p className={styles.intro}>
        When the chat model can’t see images, the agent asks this model
        questions about an image and gets text answers back.
      </p>
      <TaskError error={task.error} />
      <Section title="In use">
        <Card>
          <Toggle
            label="Image reading"
            detail={
              enabled && vision?.modelId
                ? vision.modelId
                : enabled
                  ? 'Choose a model below'
                  : 'Off'
            }
            checked={enabled}
            disabled={task.busy}
            onChange={(value) => {
              void task.run(() =>
                store.updatePreferences({ vision: { enabled: value } }),
              );
            }}
          />
        </Card>
      </Section>
      <input
        className={styles.search}
        type="search"
        aria-label="Search vision models"
        placeholder="Search models…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {search.error ? (
        <p className={styles.error} role="alert">
          {search.error}
        </p>
      ) : null}
      {models.length ? (
        <Section title="Models that read images">
          <Card>
            {models.map((model) => {
              const selected = enabled && vision?.modelId === model.id;
              return (
                <button
                  type="button"
                  className={`${styles.row} ${styles.navRow}`}
                  key={model.id}
                  disabled={task.busy}
                  aria-pressed={selected}
                  onClick={() => choose(model)}
                >
                  <Eye size={16} aria-hidden="true" />
                  <span className={styles.rowCopy}>
                    <span>{model.name}</span>
                    <span className={styles.detail}>{modelDetail(model)}</span>
                  </span>
                  {selected ? <Check size={16} aria-label="Selected" /> : null}
                </button>
              );
            })}
          </Card>
        </Section>
      ) : !search.busy && !search.error ? (
        <p className={styles.empty}>No image-reading models found.</p>
      ) : null}
      {search.cursor ? (
        <ScreenButton disabled={search.busy} onClick={search.loadMore}>
          Load more models
        </ScreenButton>
      ) : null}
    </ScreenBody>
  );
}
