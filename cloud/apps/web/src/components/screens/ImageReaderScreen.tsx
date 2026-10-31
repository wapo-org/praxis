import React from 'react';
import { Check, Eye } from '../../lib/icons';
import { GlassChip } from '@praxis/glass';
import type { Model } from '@praxis/protocol';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  ScreenBody,
  Section,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';

export function ImageReaderScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const [providerId, setProviderId] = React.useState(
    store.preferences?.vision.providerId ?? store.providers[0]?.id ?? '',
  );
  const vision = store.preferences?.vision;
  const enabled = vision?.enabled ?? true;
  const activeProvider = store.providers.some(
    (provider) => provider.id === providerId,
  )
    ? providerId
    : store.providers[0]?.id;
  const models = store.models.filter(
    (model) =>
      model.providerId === activeProvider &&
      model.supportsImages !== false &&
      `${model.displayName} ${model.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const choose = (model: Model) => {
    void task.run(() =>
      store.updatePreferences({
        vision: {
          enabled: true,
          providerId: model.providerId,
          modelId: model.id,
        },
      }),
    );
  };
  return (
    <ScreenBody>
      <p className="screen-intro">
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
      {store.providers.length ? (
        <>
          <Section title="Provider">
            <div className="screen-pill-row">
              {store.providers.map((provider) => (
                <GlassChip
                  key={provider.id}
                  active={activeProvider === provider.id}
                  aria-pressed={activeProvider === provider.id}
                  onClick={() => setProviderId(provider.id)}
                >
                  {provider.name}
                </GlassChip>
              ))}
            </div>
          </Section>
          <input
            className="screen-search"
            type="search"
            aria-label="Search vision models"
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {(['verified', 'unverified'] as const).map((group) => {
            const candidates = models.filter((model) =>
              group === 'verified'
                ? model.supportsImages === true
                : model.supportsImages == null,
            );
            if (!candidates.length) return null;
            return (
              <Section
                key={group}
                title={
                  group === 'verified'
                    ? 'Verified vision support'
                    : 'Unverified vision support'
                }
                hint={
                  group === 'unverified'
                    ? 'These models do not advertise image support. They may be unable to read images.'
                    : undefined
                }
              >
                <Card>
                  {candidates.map((model) => (
                    <button
                      type="button"
                      className="screen-row screen-nav-row"
                      key={model.id}
                      disabled={task.busy}
                      aria-pressed={
                        enabled &&
                        vision?.providerId === model.providerId &&
                        vision.modelId === model.id
                      }
                      onClick={() => choose(model)}
                    >
                      <Eye size={16} aria-hidden="true" />
                      <span className="screen-row-copy">
                        <span>{model.displayName}</span>
                        <span className="screen-detail">{model.id}</span>
                      </span>
                      {enabled &&
                      vision?.providerId === model.providerId &&
                      vision.modelId === model.id ? (
                        <Check size={17} aria-label="Selected" />
                      ) : null}
                    </button>
                  ))}
                </Card>
              </Section>
            );
          })}
          {!models.length ? (
            <p className="screen-empty">
              No image-reading models found. Refresh this provider’s models in
              Settings or try another provider.
            </p>
          ) : null}
        </>
      ) : (
        <p className="screen-empty">
          Add a provider in Settings to choose an image-reading model.
        </p>
      )}
    </ScreenBody>
  );
}
