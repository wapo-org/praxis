import React from 'react';
import { usePraxisStore } from '../../state/store.js';
import { Field, ScreenBody, ScreenButton, Section, TaskError, useScreenTask } from './ScreenUI.js';

import { apiClient } from '../../lib/api';
export function SkillImport() {
  const store = usePraxisStore();
  const task = useScreenTask();
  const [report, setReport] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [document, setDocument] = React.useState('');
  return (
    <ScreenBody>
      <Section
        title="Import from Files"
        hint="Choose a .zip, .tar or .tar.gz skill archive. Review instructions before enabling a skill."
      >
        <TaskError error={task.error} />
        <Field label="Skill archive">
          <input
            type="file"
            accept=".zip,.tar,.tar.gz"
            disabled={task.busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              setReport('');
              void task.run(async () => {
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
        {task.busy ? <p role="status">Importing…</p> : null}
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
          {task.busy ? 'Importing…' : 'Import skill'}
        </ScreenButton>
      </form>
    </ScreenBody>
  );
}
