import React from 'react';
import { Download, Grid2X2, Plus, Search, Trash2 } from '../../lib/icons';
import type { Skill } from '@praxis/protocol';
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
  Toggle,
  useScreenTask,
} from './ScreenUI.js';

function SkillEditor({
  skill,
  onClose,
}: {
  skill: Skill;
  onClose: () => void;
}) {
  const { saveSkill } = usePraxisStore();
  const task = useScreenTask();
  const [name, setName] = React.useState(skill.name);
  const [description, setDescription] = React.useState(skill.description);
  const [document, setDocument] = React.useState(skill.document);
  return (
    <form
      className="screen-form screen-list-detail"
      onSubmit={(event) => {
        event.preventDefault();
        void task.run(async () => {
          await saveSkill({
            id: skill.id,
            name: name.trim(),
            description: description.trim(),
            document,
            enabled: skill.enabled,
          });
          onClose();
        });
      }}
    >
      <TaskError error={task.error} />
      <Field label="Skill name">
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field label="SKILL.md">
        <textarea
          className="screen-mono"
          rows={14}
          maxLength={500000}
          required
          spellCheck={false}
          value={document}
          onChange={(event) => setDocument(event.target.value)}
        />
      </Field>
      <div className="screen-actions">
        <ScreenButton
          type="submit"
          tone="primary"
          disabled={task.busy || !name.trim() || !document.trim()}
        >
          Save changes
        </ScreenButton>
        <ScreenButton onClick={onClose} disabled={task.busy}>
          Cancel
        </ScreenButton>
      </div>
    </form>
  );
}

export function SkillsScreen() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [editing, setEditing] = React.useState<string | null>(null);
  return (
    <ScreenBody>
      <TaskError error={task.error} />
      <Section title="Installed">
        {store.skills.length ? (
          <Card>
            {store.skills.map((skill) => (
              <div className="screen-list-item" key={skill.id}>
                <Toggle
                  label={skill.name}
                  detail={skill.description}
                  checked={skill.enabled}
                  disabled={task.busy || editing === skill.id}
                  onChange={(enabled) => {
                    void task.run(() => store.saveSkill({ ...skill, enabled }));
                  }}
                />
                {editing === skill.id ? (
                  <SkillEditor skill={skill} onClose={() => setEditing(null)} />
                ) : (
                  <div className="screen-list-detail">
                    <div className="screen-actions">
                      <ScreenButton
                        onClick={() => setEditing(skill.id)}
                        aria-label={`Edit ${skill.name} SKILL.md`}
                      >
                        Edit SKILL.md
                      </ScreenButton>
                      <ScreenButton
                        tone="destructive"
                        disabled={task.busy}
                        aria-label={`Delete ${skill.name}`}
                        onClick={() => {
                          void task.run(() => store.removeSkill(skill.id));
                        }}
                      >
                        <Trash2 size={15} />
                        Delete
                      </ScreenButton>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </Card>
        ) : (
          <p className="screen-empty">
            No skills yet. Import a SKILL.md document or browse a skill
            registry.
          </p>
        )}
      </Section>
      <div className="screen-actions">
        <ScreenButton onClick={() => store.setActiveSheet('skill-import')}>
          <Download size={17} />
          Import skill
        </ScreenButton>
        <ScreenButton onClick={() => store.setActiveSheet('skill-browser')}>
          <Grid2X2 size={17} />
          Browse skills
        </ScreenButton>
      </div>
      <p className="screen-footnote">
        A skill is a set of instructions (SKILL.md) the agent can load when a
        task needs it. Review its instructions before enabling it.
      </p>
    </ScreenBody>
  );
}

export function SkillImport() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [document, setDocument] = React.useState('');
  return (
    <ScreenBody>
      <form
        className="screen-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await store.saveSkill({
              name: name.trim(),
              description: description.trim(),
              document,
              enabled: true,
            });
            store.setActiveSheet('skills');
          });
        }}
      >
        <TaskError error={task.error} />
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
            placeholder="My skill"
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When should the agent use this skill?"
          />
        </Field>
        <Field label="SKILL.md markdown">
          <textarea
            className="screen-mono"
            rows={16}
            required
            maxLength={500000}
            value={document}
            onChange={(event) => setDocument(event.target.value)}
            spellCheck={false}
            placeholder={'# My skill\n\nInstructions for the agent…'}
          />
        </Field>
        <ScreenButton
          type="submit"
          tone="primary"
          disabled={task.busy || !name.trim() || !document.trim()}
        >
          {task.busy ? 'Importing…' : 'Import skill'}
        </ScreenButton>
      </form>
    </ScreenBody>
  );
}

export function SkillBrowser() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [query, setQuery] = React.useState('');
  const [registryName, setRegistryName] = React.useState('');
  const [registryUrl, setRegistryUrl] = React.useState('');
  const [searched, setSearched] = React.useState(false);
  const [installed, setInstalled] = React.useState<Set<string>>(new Set());
  const enabledRegistries = store.registries.filter(
    (registry) => registry.enabled,
  );
  const search = async () => {
    await Promise.all(
      enabledRegistries.map((registry) =>
        store.searchRegistry(registry.id, query.trim()),
      ),
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
        <ScreenButton
          type="submit"
          disabled={task.busy || !enabledRegistries.length}
        >
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
                  installed.has(key) ||
                  store.skills.some((skill) => skill.id === entry.id);
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
                          await store.installSkillFromRegistry(
                            registry.id,
                            entry.id,
                          );
                          setInstalled((previous) =>
                            new Set(previous).add(key),
                          );
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
              {searched
                ? 'No skills found in this registry.'
                : 'Search to browse this registry.'}
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
          <p className="screen-empty">
            No registries yet. Add one to browse and install skills.
          </p>
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
