import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';
import type { AgentActivityViewProps } from './activityTypes';
it('hides empty object argument boxes but retains meaningful and non-JSON arguments', () => {
  for (const args of [{}, '{}', ' { \n } ']) {
    const html = renderToStaticMarkup(
      <ApprovalCards
        pendingApprovals={[
          { id: 'a', toolName: 'test', arguments: args } as NonNullable<
            AgentActivityViewProps['pendingApprovals']
          >[number],
        ]}
      />,
    );
    expect(html).not.toContain('<pre');
  }
  for (const args of [{ path: 'file.txt' }, 'echo hello']) {
    const html = renderToStaticMarkup(
      <ApprovalCards
        pendingApprovals={[
          { id: 'a', toolName: 'test', arguments: args } as NonNullable<
            AgentActivityViewProps['pendingApprovals']
          >[number],
        ]}
      />,
    );
    expect(html).toContain('<pre');
  }
});
it('labels questions by title, then description, then a humanised key', () => {
  const fields = {
    raw_key: { title: 'Your full name', description: 'Shown on the report' },
    raw_other: { description: 'Where should we save it?' },
    projectName: {},
  };
  const html = renderToStaticMarkup(
    <ElicitationCards
      pendingElicitations={[
        { id: 'e', schema: { properties: fields } } as NonNullable<
          AgentActivityViewProps['pendingElicitations']
        >[number],
      ]}
      elicitationValues={{}}
      setElicitationValues={() => {}}
    />,
  );
  expect(html).toContain('Your full name');
  expect(html).toContain('Where should we save it?');
  expect(html).toContain('Project Name');
  expect(html).not.toContain('Enter raw_key');
});
