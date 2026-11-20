import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ApprovalCards } from './ApprovalCards';
import { ElicitationCards } from './ElicitationCards';
import type { AgentActivityViewProps } from './activityTypes';
it('renders the server preview as text and hides an empty preview', () => {
  const approval = {
    type: 'approval', id: 'a', callId: 'call', toolName: 'test', title: 'Test',
    reason: 'Changes data', source: {type: 'builtin'},
  } as const;
  const empty = renderToStaticMarkup(<ApprovalCards pendingApprovals={[{...approval, arguments: ''}]} />);
  expect(empty).not.toContain('<pre');
  const preview = 'channel: #review\ntoken: [redacted]';
  const shown = renderToStaticMarkup(<ApprovalCards pendingApprovals={[{...approval, arguments: preview}]} />);
  expect(shown).toContain('<pre');
  expect(shown).toContain(preview);
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
        { id: 'e', message: 'Project details', schema: { properties: fields } } as NonNullable<
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
