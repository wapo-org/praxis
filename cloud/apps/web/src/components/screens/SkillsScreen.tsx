import type { Skill } from '@praxis/protocol';
import React from 'react';
import { Download, Grid2X2, Trash2 } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import {
  Card,
  Field,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';
import { useSkillUpdates } from './useSkillUpdates';

function SkillEditor({ skill, onClose }: { skill: Skill; onClose: () => void }) {
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
  const updates = useSkillUpdates();
  const [editing, setEditing] = React.useState<string | null>(null);
  return (
    <ScreenBody>
      <TaskError error={task.error} />
      <TaskError error={updates.error} />
      {store.skills.some((s) => s.registryId) ? (
        <div className="screen-actions">
          <ScreenButton disabled={updates.busy} onClick={() => void updates.check()}>
            {updates.busy ? 'Checking for updates…' : 'Check for updates'}
          </ScreenButton>
          {updates.checked && !updates.items.length ? (
            <span role="status">All registry skills are up to date.</span>
          ) : null}
        </div>
      ) : null}
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
                      {updates.items.some((u) => u.skillId === skill.id) ? (
                        <>
                          <span className="screen-badge">Update available</span>
                          <ScreenButton
                            disabled={updates.busy}
                            onClick={() => void updates.apply(skill.id)}
                          >
                            Update {skill.name}
                          </ScreenButton>
                        </>
                      ) : null}
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
            No skills yet. Import a SKILL.md document or browse a skill registry.
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
        A skill is a set of instructions (SKILL.md) the agent can load when a task needs it. Review
        its instructions before enabling it.
      </p>
    </ScreenBody>
  );
}

export { SkillBrowser } from './SkillBrowser';
export { SkillImport } from './SkillImport';
