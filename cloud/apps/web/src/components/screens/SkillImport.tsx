import React from 'react';
import { usePraxisStore } from '../../state/store.js';
import { Field, ScreenBody, ScreenButton, Section, TaskError, useScreenTask } from './ScreenUI.js';

import { apiClient } from '../../lib/api';
export function SkillImport() {
  const store = usePraxisStore();
  // Separate tasks: an archive failure must not show up on (or block) the manual form, and vice versa.
  const archive = useScreenTask();
  const task = useScreenTask();
  const [report, setReport] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [document, setDocument] = React.useState('');
  return (
    <ScreenBody>
      <Section
        title="Import from Files"
        hint="Choose a .zip, .skill, .tar or .tar.gz skill archive. Review instructions before enabling a skill."
      >
        <TaskError error={archive.error} />
        <Field label="Skill archive">
          <input
            type="file"
            accept=".zip,.skill,.tar,.tar.gz"
            disabled={archive.busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              setReport('');
              void archive.run(async () => {
                const attachment = await apiClient.uploadAttachment(file);
                const result = await apiClient.importSkillArchive(attachment.id);
                await store.refreshAll();
                setReport(
                  `Imported ${result.skill.name}.${result.dropped.length ? ' Skipped: ' + result.dropped.join(', ') : ''}`,
                );
              });
            }}
          />
        </Field>
        {archive.busy ? <p role="status">Uploading and importing…</p> : null}
        {report ? <p role="status">{report}</p> : null}
      </Section>
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
          {task.busy ? 'Saving…' : 'Save skill'}
        </ScreenButton>
      </form>
    </ScreenBody>
  );
}
