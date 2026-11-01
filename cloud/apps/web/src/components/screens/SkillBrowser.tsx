import React from 'react';
import { Plus, Search, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  Field,
  hostLabel,
  requireHttpUrl,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  useScreenTask,
} from './ScreenUI.js';

export function SkillBrowser() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const [registryName, setRegistryName] = React.useState('');
  const [registryUrl, setRegistryUrl] = React.useState('');
  const [searched, setSearched] = React.useState(false);
  const [installed, setInstalled] = React.useState<Set<string>>(new Set());
  const enabledRegistries = store.registries.filter((registry) => registry.enabled);
  const search = async () => {
    await Promise.all(
      enabledRegistries.map((registry) => store.searchRegistry(registry.id, query.trim())),
    );
    setSearched(true);
  };
  return (
    <ScreenBody>
      <TaskError error={task.error} />
      <form
        className="screen-actions"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(search);
        }}
      >
        <input
          style={{ flex: '1 1 200px' }}
          className="screen-search"
          type="search"
          aria-label="Search skills"
          placeholder="Search skills…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ScreenButton type="submit" disabled={task.busy || !enabledRegistries.length}>
          <Search size={16} />
          Search
        </ScreenButton>
      </form>
      {enabledRegistries.map((registry) => (
        <Section key={registry.id} title={registry.name}>
          {store.registryEntries[registry.id]?.length ? (
            <Card>
              {store.registryEntries[registry.id]!.map((entry) => {
                const key = `${registry.id}:${entry.id}`;
                const isInstalled =
                  installed.has(key) || store.skills.some((skill) => skill.registryId === registry.id && skill.registryEntryId === entry.id);
                return (
                  <div className="screen-row" key={entry.id}>
                    <span className="screen-row-copy">
                      <strong>{entry.name}</strong>
                      <span className="screen-detail">{entry.description}</span>
                    </span>
                    <ScreenButton
                      disabled={task.busy || isInstalled}
                      onClick={() => {
                        void task.run(async () => {
                          await store.installSkillFromRegistry(registry.id, entry.id);
                          setInstalled((previous) => new Set(previous).add(key));
                        });
                      }}
                    >
                      {isInstalled ? 'Installed' : 'Install'}
                    </ScreenButton>
                  </div>
                );
              })}
            </Card>
          ) : (
            <p className="screen-footnote">
              {searched ? 'No skills found in this registry.' : 'Search to browse this registry.'}
            </p>
          )}
        </Section>
      ))}
      <Section
        title="Skill registries"
        hint="Add the URL of a skill registry, then search its catalog."
      >
        {store.registries.length ? (
          <Card>
            {store.registries.map((registry) => (
              <div className="screen-row" key={registry.id}>
                <span className="screen-row-copy">
                  <strong>{registry.name}</strong>
                  <span className="screen-detail">
                    {hostLabel(registry.url)}
                    {registry.enabled ? '' : ' · Disabled'}
                  </span>
                </span>
                <ScreenButton
                  tone="destructive"
                  aria-label={`Remove ${registry.name} registry`}
                  disabled={task.busy}
                  onClick={() => {
                    void task.run(() => store.removeSkillRegistry(registry.id));
                  }}
                >
                  <Trash2 size={15} />
                </ScreenButton>
              </div>
            ))}
          </Card>
        ) : (
          <p className="screen-empty">No registries yet. Add one to browse and install skills.</p>
        )}
        <form
          className="screen-form"
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(async () => {
              const registry = await store.addSkillRegistry(
                registryName.trim(),
                requireHttpUrl(registryUrl),
              );
              setRegistryName('');
              setRegistryUrl('');
              await store.searchRegistry(registry.id, query.trim());
            });
          }}
        >
          <Field label="Registry name">
            <input
              required
              maxLength={100}
              value={registryName}
              onChange={(event) => setRegistryName(event.target.value)}
              placeholder="My registry"
            />
          </Field>
          <Field label="Registry URL">
            <input
              type="url"
              required
              value={registryUrl}
              onChange={(event) => setRegistryUrl(event.target.value)}
              placeholder="https://example.com/skills.json"
              spellCheck={false}
              autoCapitalize="none"
            />
          </Field>
          <ScreenButton
            type="submit"
            disabled={task.busy || !registryName.trim() || !registryUrl.trim()}
          >
            <Plus size={16} />
            Add registry
          </ScreenButton>
        </form>
      </Section>
    </ScreenBody>
  );
}
